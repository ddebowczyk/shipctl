import type { ModuleId } from "../protocol/panels.ts";
import type {
  SemanticServiceError,
  SemanticStreamAttachmentId,
  SemanticStreamDelivery,
} from "../protocol/semanticServices.ts";
import {
  SEMANTIC_TERMINAL_GRANTS,
  SEMANTIC_TERMINALS_ERROR_CODES,
  semanticTerminalsService,
  type SemanticTerminalAnchor,
  type SemanticTerminalEffect,
  type SemanticTerminalGrant,
  type SemanticTerminalHistoryWindow,
  type SemanticTerminalPublicationStats,
  type SemanticTerminalScreenAttachment,
  type SemanticTerminalScreenFrame,
  type SemanticTerminalScreenState,
  type SemanticTerminalsErrorCode,
  type SemanticTerminalsService,
} from "../protocol/semanticTerminals.ts";
import type {
  SemanticServiceProvider,
  SemanticServiceProviderContext,
} from "../host/semanticServices.ts";

import {
  createFakeRequestOperation,
  type FakeRequestTrace,
} from "./semanticServices.ts";

export type FakeSemanticTerminalsOperation =
  | "snapshot"
  | "input"
  | "resize"
  | "history"
  | "create-anchor"
  | "resolve-anchor"
  | "release-anchor"
  | "select"
  | "inspect-paste"
  | "publication-stats"
  | "app-memory";

export interface FakeSemanticTerminalsTrace {
  readonly operation: FakeSemanticTerminalsOperation;
  readonly request: FakeRequestTrace<unknown>;
}

export interface FakeSemanticTerminalSeed {
  readonly moduleId: ModuleId;
  readonly terminalId: string;
  readonly revision?: number;
  readonly state?: SemanticTerminalScreenState;
  readonly history?: SemanticTerminalHistoryWindow;
  readonly live?: boolean;
}

export interface FakeSemanticTerminalsHistoryEntry {
  readonly type: "input" | "resize" | "attachment-disposed";
  readonly activationId: string;
  readonly terminalId: string;
  readonly attachmentId?: string;
  readonly detail?: unknown;
}

export interface FakeSemanticTerminalsProviderOptions {
  readonly deniedGrants?: readonly SemanticTerminalGrant[];
  readonly seeds?: readonly FakeSemanticTerminalSeed[];
  readonly traces?: FakeSemanticTerminalsTrace[];
  readonly history?: FakeSemanticTerminalsHistoryEntry[];
  readonly pasteSafe?: (text: string) => boolean;
  readonly appRss?: number;
}

interface FakeTerminalRecord {
  readonly moduleId: ModuleId;
  readonly terminalId: string;
  revision: number;
  state: SemanticTerminalScreenState;
  history: SemanticTerminalHistoryWindow;
  live: boolean;
  nextAnchorId: number;
  readonly anchors: Map<number, SemanticTerminalAnchor>;
  stats: SemanticTerminalPublicationStats;
}

interface FakeBinding {
  readonly context: SemanticServiceProviderContext;
  readonly attachments: Set<FakeSemanticScreenAttachment>;
}

class FakeSemanticTerminalsFailure extends Error {
  readonly code: SemanticTerminalsErrorCode;

  constructor(code: SemanticTerminalsErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

let nextAttachmentId = 1;

const POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

const CANCELLED = {
  code: SEMANTIC_TERMINALS_ERROR_CODES.cancelled,
  message: "Semantic terminal request was cancelled",
  retryable: false,
} as const;

const DISPOSED = {
  code: SEMANTIC_TERMINALS_ERROR_CODES.activationDisposed,
  message: "The module activation is no longer active",
  retryable: false,
} as const;

const EMPTY_HISTORY: SemanticTerminalHistoryWindow = Object.freeze({
  startRow: 0,
  historyRows: 0,
  rows: Object.freeze([]),
});

function emptyStats(): SemanticTerminalPublicationStats {
  return {
    ptyReads: 0,
    screenChanges: 0,
    screenProjections: 0,
    screenEncodes: 0,
    screenEncodedBytes: 0,
    screenRecipientDeliveries: 0,
    effectEvents: 0,
    effectEncodedBytes: 0,
    currentScreenTransactions: 0,
    currentScreenBytesQueued: 0,
    peakScreenBytesQueued: 0,
    currentEffectEventsQueued: 0,
    currentEffectBytesQueued: 0,
    peakEffectEventsQueued: 0,
    peakEffectBytesQueued: 0,
  };
}

export function createFakeSemanticTerminalScreenState(
  columns = 80,
  rows = 24,
): SemanticTerminalScreenState {
  const viewport = Array.from({ length: rows }, () => ({
    wrapped: false,
    continuation: false,
    prompt: "none" as const,
    runs: [{
      glyphs: Array.from({ length: columns }, () => " "),
      width: "narrow" as const,
      bold: false,
      foreground: null,
      background: null,
    }],
  }));
  return {
    columns,
    rows,
    screen: "primary",
    scrollbackRows: 0,
    cursor: {
      column: 0,
      row: 0,
      visible: true,
      pendingWrap: false,
      shape: "block",
      blinking: true,
    },
    modes: {
      wraparound: true,
      bracketedPaste: false,
      applicationCursorKeys: false,
      applicationKeypad: false,
      focusEvents: false,
      mouseTracking: false,
      insert: false,
      reverseVideo: false,
      origin: false,
    },
    colors: { foreground: null, background: null, palette: [] },
    damage: { scope: "full", rows: [] },
    viewport,
    selection: [],
  };
}

function failedError(error: unknown): SemanticServiceError<SemanticTerminalsErrorCode> {
  if (error instanceof FakeSemanticTerminalsFailure) {
    return { code: error.code, message: error.message, retryable: false };
  }
  return {
    code: SEMANTIC_TERMINALS_ERROR_CODES.transportFailed,
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

function requireGrant(
  options: FakeSemanticTerminalsProviderOptions,
  grant: SemanticTerminalGrant,
): void {
  if (options.deniedGrants?.includes(grant)) {
    throw new FakeSemanticTerminalsFailure(
      SEMANTIC_TERMINALS_ERROR_CODES.denied,
      `Semantic terminal grant ${grant} was denied`,
    );
  }
}

function validSafeInteger(value: number, name: string, allowZero: boolean): number {
  if (
    !Number.isSafeInteger(value)
    || value < (allowZero ? 0 : 1)
  ) {
    throw new FakeSemanticTerminalsFailure(
      SEMANTIC_TERMINALS_ERROR_CODES.invalidRequest,
      `${name} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`,
    );
  }
  return value;
}

function validNativeCount(
  value: number,
  name: string,
  allowZero: boolean,
  maximum: number,
): number {
  validSafeInteger(value, name, allowZero);
  if (value > maximum) {
    throw new FakeSemanticTerminalsFailure(
      SEMANTIC_TERMINALS_ERROR_CODES.invalidRequest,
      `${name} is outside the supported native range`,
    );
  }
  return value;
}

class FakeSemanticScreenAttachment implements SemanticTerminalScreenAttachment {
  readonly id = `fake-semantic-attachment-${nextAttachmentId++}` as SemanticStreamAttachmentId;
  readonly terminalId: string;
  readonly activation;
  readonly live: boolean;
  readonly claimsResize: boolean;
  readonly snapshot;
  readonly #listener: (
    delivery: SemanticStreamDelivery<SemanticTerminalScreenFrame>,
  ) => void | Promise<void>;
  readonly #owned;
  readonly #initialGap: SemanticStreamDelivery<SemanticTerminalScreenFrame> | null;
  #pending: SemanticTerminalScreenFrame | null = null;
  #credit: number;
  #acknowledgedSequence: number | null = null;
  #lastDeliveredSequence: number | null = null;
  #active = false;
  #queue: Promise<void> = Promise.resolve();

  constructor(
    context: SemanticServiceProviderContext,
    record: FakeTerminalRecord,
    claimsResize: boolean,
    initialCredit: number,
    afterSequence: number | null,
    listener: (
      delivery: SemanticStreamDelivery<SemanticTerminalScreenFrame>,
    ) => void | Promise<void>,
    remove: () => void,
  ) {
    this.activation = context.activation;
    this.terminalId = record.terminalId;
    this.live = record.live;
    this.claimsResize = claimsResize;
    this.snapshot = Object.freeze({ revision: record.revision, state: record.state });
    this.#credit = initialCredit;
    this.#listener = listener;
    this.#owned = context.own(remove);
    this.#initialGap = afterSequence !== null && afterSequence < record.revision
      ? {
          type: "gap",
          attachmentId: this.id,
          requestedAfterSequence: afterSequence,
          earliestAvailableSequence: record.revision,
        }
      : null;
  }

  get disposed(): boolean { return this.#owned.disposed; }
  get acknowledgedSequence(): number | null { return this.#acknowledgedSequence; }
  get active(): boolean { return this.#active; }

  activate(): void {
    if (this.#active || this.disposed) return;
    this.#active = true;
    if (this.#initialGap) this.#deliver(this.#initialGap);
    this.#drain();
  }

  enqueue(frame: SemanticTerminalScreenFrame): void {
    if (this.disposed || frame.revision <= this.snapshot.revision) return;
    if (this.#lastDeliveredSequence !== null && frame.revision <= this.#lastDeliveredSequence) {
      throw new Error("Fake semantic terminal revisions must increase");
    }
    this.#pending = this.#pending === null
      ? frame
      : Object.freeze({
          ...frame,
          effects: Object.freeze([...this.#pending.effects, ...frame.effects]),
        });
    this.#drain();
  }

  grant(credit: number): void {
    if (!Number.isSafeInteger(credit) || credit < 1) {
      throw new Error("Stream credit must be a positive safe integer");
    }
    if (this.disposed) return;
    this.#credit += credit;
    this.#drain();
  }

  acknowledge(sequence: number): void {
    if (
      !Number.isSafeInteger(sequence)
      || this.#lastDeliveredSequence === null
      || sequence > this.#lastDeliveredSequence
      || (this.#acknowledgedSequence !== null && sequence < this.#acknowledgedSequence)
    ) {
      throw new Error("Stream acknowledgement is outside the delivered revision");
    }
    this.#acknowledgedSequence = sequence;
  }

  settled(): Promise<void> { return this.#queue; }
  dispose(): Promise<void> { return this.#owned.dispose(); }

  disconnect(reason: string, resumable: boolean): Promise<void> {
    if (this.disposed) return this.#queue;
    this.#deliver({
      type: "disconnected",
      attachmentId: this.id,
      reason,
      resumable,
    });
    this.#queue = this.#queue.then(() => this.dispose());
    return this.#queue;
  }

  #deliver(delivery: SemanticStreamDelivery<SemanticTerminalScreenFrame>): void {
    this.#queue = this.#queue.then(async () => {
      if (!this.disposed) await this.#listener(delivery);
    });
  }

  #drain(): void {
    if (!this.#active || this.#credit < 1 || this.#pending === null || this.disposed) return;
    const frame = this.#pending;
    this.#pending = null;
    this.#credit -= 1;
    this.#lastDeliveredSequence = frame.revision;
    this.#deliver({
      type: "frame",
      attachmentId: this.id,
      sequence: frame.revision,
      value: frame,
    });
  }
}

/** Mutable native-free semantic-terminal host for generated module workflows. */
export class FakeSemanticTerminalsHost {
  readonly #options: FakeSemanticTerminalsProviderOptions;
  readonly #terminals = new Map<string, FakeTerminalRecord>();
  readonly #bindings = new Set<FakeBinding>();

  constructor(options: FakeSemanticTerminalsProviderOptions = {}) {
    this.#options = options;
    for (const seed of options.seeds ?? []) {
      this.#terminals.set(seed.terminalId, {
        moduleId: seed.moduleId,
        terminalId: seed.terminalId,
        revision: seed.revision ?? 0,
        state: seed.state ?? createFakeSemanticTerminalScreenState(),
        history: seed.history ?? EMPTY_HISTORY,
        live: seed.live ?? true,
        nextAnchorId: 1,
        anchors: new Map(),
        stats: emptyStats(),
      });
    }
  }

  provider(): SemanticServiceProvider<SemanticTerminalsService> {
    return { service: semanticTerminalsService, bind: (context) => this.#bind(context) };
  }

  async publishScreen(
    terminalId: string,
    state: SemanticTerminalScreenState,
    effects: readonly SemanticTerminalEffect[] = [],
  ): Promise<number> {
    const record = this.#terminal(terminalId);
    record.revision += 1;
    record.state = state;
    record.stats = {
      ...record.stats,
      screenChanges: record.stats.screenChanges + 1,
      screenProjections: record.stats.screenProjections + 1,
      screenRecipientDeliveries: record.stats.screenRecipientDeliveries
        + [...this.#bindings].reduce(
          (count, binding) => count + [...binding.attachments]
            .filter((attachment) => attachment.terminalId === terminalId).length,
          0,
        ),
      effectEvents: record.stats.effectEvents + effects.length,
    };
    const frame = Object.freeze({ revision: record.revision, state, effects });
    for (const binding of this.#bindings) {
      for (const attachment of binding.attachments) {
        if (attachment.terminalId === terminalId) attachment.enqueue(frame);
      }
    }
    await Promise.all([...this.#bindings].flatMap((binding) =>
      [...binding.attachments].map((attachment) => attachment.settled())
    ));
    return record.revision;
  }

  async disconnect(terminalId: string, reason: string, resumable: boolean): Promise<void> {
    const record = this.#terminal(terminalId);
    record.live = false;
    await Promise.all([...this.#bindings].flatMap((binding) =>
      [...binding.attachments]
        .filter((attachment) => attachment.terminalId === terminalId)
        .map((attachment) => attachment.disconnect(reason, resumable))
    ));
  }

  #bind(context: SemanticServiceProviderContext): SemanticTerminalsService {
    const binding: FakeBinding = { context, attachments: new Set() };
    this.#bindings.add(binding);
    context.own(() => { this.#bindings.delete(binding); });

    const operation = <Input, Output>(
      name: FakeSemanticTerminalsOperation,
      grant: SemanticTerminalGrant,
      handle: (input: Input) => Output | Promise<Output>,
    ) => {
      const traces: FakeRequestTrace<Input>[] = [];
      const request = createFakeRequestOperation<Input, Output, SemanticTerminalsErrorCode>({
        context,
        policy: POLICY,
        handle: ({ input }) => {
          requireGrant(this.#options, grant);
          return handle(input);
        },
        failedError,
        cancelledError: CANCELLED,
        disposedError: DISPOSED,
        trace: traces,
      });
      const execute = request.execute.bind(request);
      return Object.freeze({
        policy: request.policy,
        async execute(input: Input, requestOptions?: Parameters<typeof execute>[1]) {
          const count = traces.length;
          const outcome = await execute(input, requestOptions);
          const captured = traces[count];
          if (captured) options.traces?.push({ operation: name, request: captured });
          return outcome;
        },
      });
    };
    const options = this.#options;
    const ownTerminal = (terminalId: string): FakeTerminalRecord => {
      const record = this.#terminal(terminalId);
      if (record.moduleId !== context.activation.moduleId) {
        throw new FakeSemanticTerminalsFailure(
          SEMANTIC_TERMINALS_ERROR_CODES.denied,
          "The semantic terminal is not owned by this activation",
        );
      }
      return record;
    };
    const ownAttachedTerminal = (terminalId: string): FakeTerminalRecord => {
      const record = ownTerminal(terminalId);
      if (![...binding.attachments].some((attachment) => attachment.terminalId === terminalId)) {
        throw new FakeSemanticTerminalsFailure(
          SEMANTIC_TERMINALS_ERROR_CODES.denied,
          "The activation has no semantic attachment for this terminal",
        );
      }
      return record;
    };

    return Object.freeze({
      snapshot: operation("snapshot", SEMANTIC_TERMINAL_GRANTS.inspect, ({ terminalId }) =>
        ownTerminal(terminalId).state),
      input: operation("input", SEMANTIC_TERMINAL_GRANTS.input, ({ terminalId, input }) => {
        ownAttachedTerminal(terminalId);
        const text = input.kind === "key" ? input.text ?? "" : "text" in input ? input.text : "";
        const encodedBytes = new TextEncoder().encode(text).length;
        options.history?.push({
          type: "input",
          activationId: context.activation.activationId,
          terminalId,
          detail: input,
        });
        return { encodedBytes };
      }),
      resize: operation("resize", SEMANTIC_TERMINAL_GRANTS.attach, (input) => {
        ownTerminal(input.terminalId);
        const attachment = [...binding.attachments].find(
          (candidate) => candidate.id === input.attachmentId
            && candidate.terminalId === input.terminalId,
        );
        if (!attachment?.claimsResize) {
          throw new FakeSemanticTerminalsFailure(
            SEMANTIC_TERMINALS_ERROR_CODES.denied,
            "The activation does not own semantic-terminal resize authority",
          );
        }
        const columns = validNativeCount(input.columns, "columns", false, 65_535);
        const rows = validNativeCount(input.rows, "rows", false, 65_535);
        options.history?.push({
          type: "resize",
          activationId: context.activation.activationId,
          terminalId: input.terminalId,
          attachmentId: input.attachmentId,
          detail: { columns, rows },
        });
        return {};
      }),
      history: operation("history", SEMANTIC_TERMINAL_GRANTS.attach, (input) => {
        validNativeCount(input.startRow, "startRow", true, 4_294_967_295);
        validNativeCount(input.rows, "rows", true, 4_294_967_295);
        return ownTerminal(input.terminalId).history;
      }),
      createAnchor: operation("create-anchor", SEMANTIC_TERMINAL_GRANTS.attach, (input) => {
        const record = ownTerminal(input.terminalId);
        const anchor: SemanticTerminalAnchor = {
          id: record.nextAnchorId++,
          retained: true,
          lossReported: false,
          history: input.space === "history" ? input.at : null,
          screen: input.space === "screen" ? input.at : null,
          viewport: input.space === "viewport" ? input.at : null,
          active: input.space === "active" ? input.at : null,
        };
        record.anchors.set(anchor.id, anchor);
        return anchor;
      }),
      resolveAnchor: operation("resolve-anchor", SEMANTIC_TERMINAL_GRANTS.attach, (input) =>
        ownTerminal(input.terminalId).anchors.get(input.anchorId) ?? null),
      releaseAnchor: operation("release-anchor", SEMANTIC_TERMINAL_GRANTS.attach, (input) => ({
        released: ownTerminal(input.terminalId).anchors.delete(input.anchorId),
      })),
      select: operation("select", SEMANTIC_TERMINAL_GRANTS.attach, (input) => {
        ownTerminal(input.terminalId);
        return input.request.kind === "clear"
          ? { active: false, text: null }
          : { active: true, text: "" };
      }),
      inspectPaste: operation("inspect-paste", SEMANTIC_TERMINAL_GRANTS.input, ({ text }) => ({
        safe: options.pasteSafe?.(text) ?? !/[\r\n]/u.test(text),
      })),
      publicationStats: operation(
        "publication-stats",
        SEMANTIC_TERMINAL_GRANTS.inspect,
        ({ terminalId }) => ownTerminal(terminalId).stats,
      ),
      appMemory: operation("app-memory", SEMANTIC_TERMINAL_GRANTS.inspect, () => ({
        appRss: options.appRss ?? 0,
      })),
      screens: Object.freeze({
        attach: async (request, listener) => {
          requireGrant(options, SEMANTIC_TERMINAL_GRANTS.attach);
          if (!Number.isSafeInteger(request.initialCredit) || request.initialCredit < 0) {
            throw new FakeSemanticTerminalsFailure(
              SEMANTIC_TERMINALS_ERROR_CODES.invalidRequest,
              "Initial stream credit must be a non-negative safe integer",
            );
          }
          if (
            request.afterSequence !== null
            && (!Number.isSafeInteger(request.afterSequence) || request.afterSequence < 0)
          ) {
            throw new FakeSemanticTerminalsFailure(
              SEMANTIC_TERMINALS_ERROR_CODES.invalidRequest,
              "Replay revision must be a non-negative safe integer or null",
            );
          }
          const record = ownTerminal(request.terminalId);
          if (
            request.afterSequence !== null
            && request.afterSequence > record.revision
          ) {
            throw new FakeSemanticTerminalsFailure(
              SEMANTIC_TERMINALS_ERROR_CODES.invalidRequest,
              "Replay revision is ahead of the semantic snapshot",
            );
          }
          let attachment: FakeSemanticScreenAttachment;
          attachment = new FakeSemanticScreenAttachment(
            context,
            record,
            request.claimsResize,
            request.initialCredit,
            request.afterSequence,
            listener,
            () => {
              binding.attachments.delete(attachment);
              options.history?.push({
                type: "attachment-disposed",
                activationId: context.activation.activationId,
                terminalId: request.terminalId,
                attachmentId: attachment.id,
              });
            },
          );
          binding.attachments.add(attachment);
          return attachment;
        },
      }),
    });
  }

  #terminal(terminalId: string): FakeTerminalRecord {
    const record = this.#terminals.get(terminalId);
    if (!record) {
      throw new FakeSemanticTerminalsFailure(
        SEMANTIC_TERMINALS_ERROR_CODES.notFound,
        "The semantic terminal does not exist",
      );
    }
    return record;
  }
}

/** Tauri-free semantic-terminal provider with an inspectable deterministic host. */
export function createFakeSemanticTerminalsServiceProvider(
  options: FakeSemanticTerminalsProviderOptions = {},
): {
  readonly provider: SemanticServiceProvider<SemanticTerminalsService>;
  readonly host: FakeSemanticTerminalsHost;
} {
  const host = new FakeSemanticTerminalsHost(options);
  return { provider: host.provider(), host };
}
