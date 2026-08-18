import { Channel, invoke } from "@tauri-apps/api/core";
import {
  SEMANTIC_TERMINAL_GRANTS,
  SEMANTIC_TERMINALS_ERROR_CODES,
  semanticTerminalsService,
  type AttachSemanticTerminalScreenInput,
  type CreateSemanticTerminalAnchorInput,
  type InputSemanticTerminalInput,
  type InspectSemanticTerminalPasteInput,
  type InspectSemanticTerminalPublicationInput,
  type InspectSemanticTerminalSnapshotInput,
  type ModuleId,
  type ReadSemanticTerminalHistoryInput,
  type ReleaseSemanticTerminalAnchorInput,
  type ResizeSemanticTerminalInput,
  type ResolveSemanticTerminalAnchorInput,
  type SelectSemanticTerminalInput,
  type SemanticCorrelationId,
  type SemanticOwnedLease,
  type SemanticRequestOperation,
  type SemanticResult,
  type SemanticServiceError,
  type SemanticServiceProvider,
  type SemanticStreamAttachmentId,
  type SemanticStreamDelivery,
  type SemanticTerminalGrant,
  type SemanticTerminalScreenAttachment,
  type SemanticTerminalScreenFrame,
  type SemanticTerminalsErrorCode,
  type SemanticTerminalsService,
} from "@shipctl/module-api";

import {
  createSemanticRequestAdapter,
  type PrivateSemanticRequestEnvelope,
} from "./semanticServiceAdapter.ts";
import {
  decodeAppMemory,
  decodeBoolean,
  decodeEncodedByteCount,
  decodeNativeSemanticTerminalAttachment,
  decodeNativeSemanticTerminalEvent,
  decodeResolvedSemanticTerminalAnchor,
  decodeSemanticTerminalAnchor,
  decodeSemanticTerminalHistory,
  decodeSemanticTerminalPublicationStats,
  decodeSemanticTerminalScreenState,
  decodeSemanticTerminalSelection,
  type NativeSemanticTerminalAttachment,
  type NativeSemanticTerminalEvent,
} from "./semanticTerminalWire.ts";

const COMMANDS = {
  snapshot: "get_semantic_terminal_snapshot",
  attach: "attach_semantic_terminal",
  creditScreen: "credit_semantic_terminal_screen",
  detach: "detach_semantic_terminal",
  resize: "resize_semantic_terminal",
  input: "input_semantic_terminal",
  history: "history_semantic_terminal",
  anchor: "anchor_semantic_terminal",
  resolveAnchor: "resolve_semantic_terminal_anchor",
  releaseAnchor: "release_semantic_terminal_anchor",
  select: "select_semantic_terminal",
  pasteSafety: "is_semantic_terminal_paste_safe",
  publicationStats: "get_semantic_terminal_publication_stats",
  appMemory: "get_semantic_terminal_app_memory",
  releaseActivation: "release_semantic_terminal_activation",
} as const;

export interface SemanticTerminalsTransportBinding {
  readonly moduleId: ModuleId;
  readonly activationId: string;
  readonly grants: ReadonlySet<string>;
}

type NativeAttachSemanticTerminalInput = Pick<
  AttachSemanticTerminalScreenInput,
  "terminalId" | "claimsResize"
>;
interface CreditSemanticTerminalScreenInput {
  readonly attachmentId: string;
  readonly committedSequence: number;
}
interface DetachSemanticTerminalInput {
  readonly attachmentId: string;
}

/** Private native transport. Modules receive only SemanticTerminalsService. */
export interface SemanticTerminalsNativeTransport {
  snapshot(
    request: PrivateSemanticRequestEnvelope<InspectSemanticTerminalSnapshotInput>,
  ): Promise<unknown>;
  attach(
    request: PrivateSemanticRequestEnvelope<NativeAttachSemanticTerminalInput>,
    deliver: (raw: unknown) => void,
  ): Promise<unknown>;
  creditScreen(
    request: PrivateSemanticRequestEnvelope<CreditSemanticTerminalScreenInput>,
  ): Promise<void>;
  detach(
    request: PrivateSemanticRequestEnvelope<DetachSemanticTerminalInput>,
  ): Promise<void>;
  resize(request: PrivateSemanticRequestEnvelope<ResizeSemanticTerminalInput>): Promise<void>;
  input(request: PrivateSemanticRequestEnvelope<InputSemanticTerminalInput>): Promise<unknown>;
  history(
    request: PrivateSemanticRequestEnvelope<ReadSemanticTerminalHistoryInput>,
  ): Promise<unknown>;
  anchor(
    request: PrivateSemanticRequestEnvelope<CreateSemanticTerminalAnchorInput>,
  ): Promise<unknown>;
  resolveAnchor(
    request: PrivateSemanticRequestEnvelope<ResolveSemanticTerminalAnchorInput>,
  ): Promise<unknown>;
  releaseAnchor(
    request: PrivateSemanticRequestEnvelope<ReleaseSemanticTerminalAnchorInput>,
  ): Promise<unknown>;
  select(request: PrivateSemanticRequestEnvelope<SelectSemanticTerminalInput>): Promise<unknown>;
  inspectPaste(
    request: PrivateSemanticRequestEnvelope<InspectSemanticTerminalPasteInput>,
  ): Promise<unknown>;
  publicationStats(
    request: PrivateSemanticRequestEnvelope<InspectSemanticTerminalPublicationInput>,
  ): Promise<unknown>;
  appMemory(
    request: PrivateSemanticRequestEnvelope<Readonly<Record<never, never>>>,
  ): Promise<unknown>;
  releaseActivation(
    request: PrivateSemanticRequestEnvelope<Readonly<Record<never, never>>>,
  ): Promise<unknown>;
}

export interface SemanticTerminalsServiceProviderOptions {
  readonly bindingsByActivation: ReadonlyMap<string, SemanticTerminalsTransportBinding>;
  // This browser adapter owns only activation and attachment leases. Terminal
  // ownership remains lifecycle attribution; native authority admits the
  // semantic-terminal driver selected for the terminal.
  readonly transport?: SemanticTerminalsNativeTransport;
  readonly correlationId?: () => SemanticCorrelationId;
  readonly observeRequest?: (
    operation: string,
    request: PrivateSemanticRequestEnvelope<unknown>,
  ) => void;
}

const TAURI_SEMANTIC_TERMINALS_TRANSPORT: SemanticTerminalsNativeTransport = {
  snapshot: (request) => invoke(COMMANDS.snapshot, { request }),
  async attach(request, deliver) {
    const channel = new Channel<unknown>();
    channel.onmessage = deliver;
    return invoke(COMMANDS.attach, { request, onEvent: channel });
  },
  creditScreen: (request) => invoke(COMMANDS.creditScreen, { request }),
  detach: (request) => invoke(COMMANDS.detach, { request }),
  resize: (request) => invoke(COMMANDS.resize, { request }),
  input: (request) => invoke(COMMANDS.input, { request }),
  history: (request) => invoke(COMMANDS.history, { request }),
  anchor: (request) => invoke(COMMANDS.anchor, { request }),
  resolveAnchor: (request) => invoke(COMMANDS.resolveAnchor, { request }),
  releaseAnchor: (request) => invoke(COMMANDS.releaseAnchor, { request }),
  select: (request) => invoke(COMMANDS.select, { request }),
  inspectPaste: (request) => invoke(COMMANDS.pasteSafety, { request }),
  publicationStats: (request) => invoke(COMMANDS.publicationStats, { request }),
  appMemory: (request) => invoke(COMMANDS.appMemory, { request }),
  releaseActivation: (request) => invoke(COMMANDS.releaseActivation, { request }),
};

const POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

function failure(
  code: SemanticTerminalsErrorCode,
  message: string,
): SemanticServiceError<SemanticTerminalsErrorCode> {
  return { code, message, retryable: false };
}

const CANCELLED = failure(
  SEMANTIC_TERMINALS_ERROR_CODES.cancelled,
  "Semantic terminal request was cancelled",
);
const DISPOSED = failure(
  SEMANTIC_TERMINALS_ERROR_CODES.activationDisposed,
  "The module activation is no longer active",
);

function correlationId(): SemanticCorrelationId {
  return crypto.randomUUID() as SemanticCorrelationId;
}

class SemanticTerminalsFailure extends Error {
  readonly code: SemanticTerminalsErrorCode;

  constructor(code: SemanticTerminalsErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function transportError(error: unknown): SemanticServiceError<SemanticTerminalsErrorCode> {
  if (error instanceof SemanticTerminalsFailure) return failure(error.code, error.message);
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && "message" in error
    && typeof error.code === "string"
    && typeof error.message === "string"
    && Object.values(SEMANTIC_TERMINALS_ERROR_CODES).includes(
      error.code as SemanticTerminalsErrorCode,
    )
  ) {
    return failure(error.code as SemanticTerminalsErrorCode, error.message);
  }
  const message = errorMessage(error);
  if (/not found|unavailable|exited|closing|shutting down/i.test(message)) {
    return failure(
      SEMANTIC_TERMINALS_ERROR_CODES.notFound,
      "The semantic terminal is unavailable",
    );
  }
  if (/denied|does not own|not authorized/i.test(message)) {
    return failure(
      SEMANTIC_TERMINALS_ERROR_CODES.denied,
      "The semantic terminal operation was denied",
    );
  }
  if (/rejected semantic terminal|protocol|invalid .*value/i.test(message)) {
    return failure(
      SEMANTIC_TERMINALS_ERROR_CODES.protocolFailed,
      "The semantic terminal returned an invalid value",
    );
  }
  return failure(
    SEMANTIC_TERMINALS_ERROR_CODES.transportFailed,
    "The semantic terminal transport failed",
  );
}

function requireGrant(
  binding: SemanticTerminalsTransportBinding,
  grant: SemanticTerminalGrant,
): void {
  if (!binding.grants.has(grant)) {
    throw new SemanticTerminalsFailure(
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
    throw new SemanticTerminalsFailure(
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
    throw new SemanticTerminalsFailure(
      SEMANTIC_TERMINALS_ERROR_CODES.invalidRequest,
      `${name} is outside the supported native range`,
    );
  }
  return value;
}

function request<Input, Output>(
  operation: string,
  binding: SemanticTerminalsTransportBinding,
  active: () => boolean,
  grant: SemanticTerminalGrant,
  createCorrelationId: () => SemanticCorrelationId,
  observeRequest: SemanticTerminalsServiceProviderOptions["observeRequest"],
  execute: (
    input: Input,
    envelope: PrivateSemanticRequestEnvelope<Input>,
  ) => Output | Promise<Output>,
): SemanticRequestOperation<Input, Output, SemanticTerminalsErrorCode> {
  return createSemanticRequestAdapter({
    activation: {
      moduleId: binding.moduleId,
      activationId: binding.activationId as never,
    },
    active,
    policy: POLICY,
    correlationId: createCorrelationId,
    cancelledError: CANCELLED,
    disposedError: DISPOSED,
    transportError,
    transport: {
      async request(envelope): Promise<SemanticResult<Output, SemanticTerminalsErrorCode>> {
        observeRequest?.(operation, envelope);
        requireGrant(binding, grant);
        return { ok: true, value: await execute(envelope.input, envelope) };
      },
    },
  });
}

function transportEnvelope<Input>(
  binding: SemanticTerminalsTransportBinding,
  createCorrelationId: () => SemanticCorrelationId,
  input: Input,
): PrivateSemanticRequestEnvelope<Input> {
  return {
    activation: {
      moduleId: binding.moduleId,
      activationId: binding.activationId as never,
    },
    correlationId: createCorrelationId(),
    input,
  };
}

class SemanticScreenAttachment implements SemanticTerminalScreenAttachment {
  readonly id: SemanticStreamAttachmentId;
  readonly terminalId: string;
  readonly activation;
  readonly live: boolean;
  readonly snapshot;
  readonly #native: NativeSemanticTerminalAttachment;
  readonly #transport: SemanticTerminalsNativeTransport;
  readonly #createCorrelationId: () => SemanticCorrelationId;
  readonly #listener: (
    delivery: SemanticStreamDelivery<SemanticTerminalScreenFrame>,
  ) => void | Promise<void>;
  readonly #remove: () => void;
  readonly #beforeActivate: NativeSemanticTerminalEvent[] = [];
  readonly #effects: Array<{ readonly sequence: number; readonly value: SemanticTerminalScreenFrame["effects"] }> = [];
  readonly #rawSequenceByRevision = new Map<number, number>();
  readonly #requestedAfterSequence: number | null;
  #owned: SemanticOwnedLease | null = null;
  #active = false;
  #disposed = false;
  #availableCredit: number;
  #awaitingScreen = false;
  #committedRawSequence: number | null;
  #lastNativeSequence: number;
  #lastDeliveredRevision: number;
  #acknowledgedSequence: number | null = null;
  #queue: Promise<void> = Promise.resolve();
  #pendingFailure: string | null = null;

  constructor(
    binding: SemanticTerminalsTransportBinding,
    native: NativeSemanticTerminalAttachment,
    request: AttachSemanticTerminalScreenInput,
    transport: SemanticTerminalsNativeTransport,
    createCorrelationId: () => SemanticCorrelationId,
    listener: (
      delivery: SemanticStreamDelivery<SemanticTerminalScreenFrame>,
    ) => void | Promise<void>,
    remove: () => void,
  ) {
    this.id = native.attachmentId as SemanticStreamAttachmentId;
    this.terminalId = request.terminalId;
    this.activation = {
      moduleId: binding.moduleId,
      activationId: binding.activationId as never,
    };
    this.live = native.live;
    this.snapshot = Object.freeze({ revision: native.revision, state: native.snapshot });
    this.#native = native;
    this.#transport = transport;
    this.#createCorrelationId = createCorrelationId;
    this.#listener = listener;
    this.#remove = remove;
    this.#requestedAfterSequence = request.afterSequence;
    this.#availableCredit = request.initialCredit;
    this.#committedRawSequence = native.sequenceBoundary;
    this.#lastNativeSequence = native.sequenceBoundary;
    this.#lastDeliveredRevision = native.revision;
  }

  bindOwned(owned: SemanticOwnedLease): void { this.#owned = owned; }

  get disposed(): boolean { return this.#disposed || this.#owned?.disposed === true; }
  get acknowledgedSequence(): number | null { return this.#acknowledgedSequence; }
  get active(): boolean { return this.#active; }

  activate(): void {
    if (this.#active || this.disposed) return;
    this.#active = true;
    if (
      this.#requestedAfterSequence !== null
      && this.#requestedAfterSequence < this.snapshot.revision
    ) {
      void this.#deliver({
        type: "gap",
        attachmentId: this.id,
        requestedAfterSequence: this.#requestedAfterSequence,
        earliestAvailableSequence: this.snapshot.revision,
      });
    }
    for (const event of this.#beforeActivate.splice(0)) this.#observeActive(event);
    if (this.#pendingFailure !== null) {
      void this.#disconnect(this.#pendingFailure, false);
      return;
    }
    if (!this.live) {
      void this.#disconnect("semantic-terminal-exited", false);
      return;
    }
    this.#pump();
  }

  observe(event: NativeSemanticTerminalEvent): void {
    if (this.disposed) return;
    if (!this.#active) {
      this.#beforeActivate.push(event);
      return;
    }
    this.#observeActive(event);
  }

  protocolFailure(error: unknown): void {
    if (this.disposed || this.#pendingFailure !== null) return;
    this.#pendingFailure = `semantic-terminal-protocol-failed: ${errorMessage(error)}`;
    if (this.#active) void this.#disconnect(this.#pendingFailure, false);
  }

  grant(credit: number): void {
    if (!Number.isSafeInteger(credit) || credit < 1) {
      throw new Error("Semantic terminal stream credit must be a positive safe integer");
    }
    if (this.disposed) return;
    this.#availableCredit += credit;
    this.#pump();
  }

  acknowledge(revision: number): void {
    const rawSequence = this.#rawSequenceByRevision.get(revision);
    if (
      !Number.isSafeInteger(revision)
      || rawSequence === undefined
      || revision > this.#lastDeliveredRevision
      || (this.#acknowledgedSequence !== null && revision < this.#acknowledgedSequence)
    ) {
      throw new Error("Semantic terminal acknowledgement is outside the delivered revision");
    }
    this.#acknowledgedSequence = revision;
    this.#committedRawSequence = rawSequence;
    for (const deliveredRevision of this.#rawSequenceByRevision.keys()) {
      if (deliveredRevision < revision) this.#rawSequenceByRevision.delete(deliveredRevision);
    }
    this.#pump();
  }

  dispose(): Promise<void> {
    if (this.#owned) return this.#owned.dispose();
    return this.#close();
  }

  /** Activation-owner cleanup. It must not re-enter the owning lease. */
  closeFromOwner(): Promise<void> {
    return this.#close();
  }

  async #close(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#remove();
    this.#beforeActivate.length = 0;
    this.#effects.length = 0;
    try {
      await this.#transport.detach(this.#envelope({
        attachmentId: this.#native.attachmentId,
      }));
    } catch {
      // Native detachment is idempotent from the public lease's point of view.
    }
  }

  #observeActive(event: NativeSemanticTerminalEvent): void {
    if (event.sequence < this.#lastNativeSequence) {
      this.protocolFailure(new Error("native event sequence moved backwards"));
      return;
    }
    this.#lastNativeSequence = event.sequence;
    switch (event.event) {
      case "effects":
        this.#effects.push({ sequence: event.sequence, value: event.effects });
        return;
      case "screen": {
        if (!this.#awaitingScreen || this.#availableCredit < 1) {
          this.protocolFailure(new Error("native screen arrived without public credit"));
          return;
        }
        if (event.revision <= this.#lastDeliveredRevision) {
          this.protocolFailure(new Error("semantic revision did not increase"));
          return;
        }
        this.#awaitingScreen = false;
        this.#availableCredit -= 1;
        this.#lastDeliveredRevision = event.revision;
        this.#rawSequenceByRevision.set(event.revision, event.sequence);
        const effects = this.#effects
          .filter(({ sequence }) => sequence <= event.sequence)
          .flatMap(({ value }) => value);
        for (let index = this.#effects.length - 1; index >= 0; index -= 1) {
          if (this.#effects[index].sequence <= event.sequence) this.#effects.splice(index, 1);
        }
        void this.#deliver({
          type: "frame",
          attachmentId: this.id,
          sequence: event.revision,
          value: { revision: event.revision, state: event.state, effects },
        });
        return;
      }
      case "resync_required":
        void this.#disconnect(`semantic-terminal-resync-required: ${event.reason}`, true);
        return;
      case "detached":
        void this.#disconnect(`semantic-terminal-detached: ${event.reason}`, true);
        return;
      case "exited":
        void this.#disconnect("semantic-terminal-exited", false);
        return;
      case "unsupported":
        this.protocolFailure(new Error(`unexpected ${event.source} event on semantic stream`));
        return;
      case "metadata_changed":
      case "agent_activity_changed":
        return;
    }
  }

  #pump(): void {
    if (
      !this.#active
      || this.disposed
      || !this.live
      || this.#availableCredit < 1
      || this.#awaitingScreen
      || this.#committedRawSequence === null
    ) {
      return;
    }
    const committedSequence = this.#committedRawSequence;
    this.#committedRawSequence = null;
    this.#awaitingScreen = true;
    void this.#transport.creditScreen(this.#envelope({
      attachmentId: this.#native.attachmentId,
      committedSequence,
    })).catch((error) => {
      if (this.disposed) return;
      this.#awaitingScreen = false;
      void this.#disconnect(`semantic-terminal-credit-failed: ${errorMessage(error)}`, true);
    });
  }

  #deliver(
    delivery: SemanticStreamDelivery<SemanticTerminalScreenFrame>,
  ): Promise<void> {
    const result = this.#queue.then(async () => {
      if (!this.disposed) await this.#listener(delivery);
    });
    this.#queue = result.catch(() => undefined);
    return this.#queue;
  }

  async #disconnect(reason: string, resumable: boolean): Promise<void> {
    if (this.disposed) return;
    await this.#deliver({
      type: "disconnected",
      attachmentId: this.id,
      reason,
      resumable,
    });
    await this.#owned?.dispose();
  }

  #envelope<Input>(input: Input): PrivateSemanticRequestEnvelope<Input> {
    return {
      activation: this.activation,
      correlationId: this.#createCorrelationId(),
      input,
    };
  }
}

/** Trusted activation adapter over the private semantic-terminal transport. */
export function createSemanticTerminalsServiceProvider(
  options: SemanticTerminalsServiceProviderOptions,
): SemanticServiceProvider<SemanticTerminalsService> {
  const createCorrelationId = options.correlationId ?? correlationId;
  const transport = options.transport ?? TAURI_SEMANTIC_TERMINALS_TRANSPORT;
  return {
    service: semanticTerminalsService,
    bind(context) {
      const binding = options.bindingsByActivation.get(context.activation.activationId);
      if (
        !binding
        || binding.moduleId !== context.activation.moduleId
        || binding.activationId !== context.activation.activationId
      ) {
        throw new Error("The module activation has no admitted semantic-terminal binding");
      }
      const attachments = new Map<string, { readonly terminalId: string; readonly claimsResize: boolean }>();
      const active = () => context.active;
      const ownAttachedTerminal = (terminalId: string) => {
        if (![...attachments.values()].some((owner) => owner.terminalId === terminalId)) {
          throw new SemanticTerminalsFailure(
            SEMANTIC_TERMINALS_ERROR_CODES.denied,
            "The activation has no semantic attachment for this terminal",
          );
        }
      };
      context.own(async () => {
        try {
          await transport.releaseActivation(
            transportEnvelope(binding, createCorrelationId, {}),
          );
        } catch {
          // The activation is locally disposed even if native cleanup reports
          // an already-released lease.
        }
      });

      return Object.freeze({
        snapshot: request<InspectSemanticTerminalSnapshotInput, ReturnType<typeof decodeSemanticTerminalScreenState>>(
          "snapshot", binding, active, SEMANTIC_TERMINAL_GRANTS.inspect,
          createCorrelationId, options.observeRequest, async (_input, envelope) => {
            return decodeSemanticTerminalScreenState(await transport.snapshot(envelope));
          }),
        input: request<InputSemanticTerminalInput, { readonly encodedBytes: number }>(
          "input", binding, active, SEMANTIC_TERMINAL_GRANTS.input,
          createCorrelationId, options.observeRequest, async ({ terminalId }, envelope) => {
            ownAttachedTerminal(terminalId);
            return { encodedBytes: decodeEncodedByteCount(await transport.input(envelope)) };
          }),
        resize: request<ResizeSemanticTerminalInput, Readonly<Record<never, never>>>(
          "resize", binding, active, SEMANTIC_TERMINAL_GRANTS.attach,
          createCorrelationId, options.observeRequest, async (input, envelope) => {
            const owner = attachments.get(input.attachmentId);
            if (!owner || owner.terminalId !== input.terminalId || !owner.claimsResize) {
              throw new SemanticTerminalsFailure(
                SEMANTIC_TERMINALS_ERROR_CODES.denied,
                "The activation does not own semantic-terminal resize authority",
              );
            }
            const columns = validNativeCount(input.columns, "columns", false, 65_535);
            const rows = validNativeCount(input.rows, "rows", false, 65_535);
            await transport.resize({
              ...envelope,
              input: { ...input, columns, rows },
            });
            return {};
          }),
        history: request<ReadSemanticTerminalHistoryInput, ReturnType<typeof decodeSemanticTerminalHistory>>(
          "history", binding, active, SEMANTIC_TERMINAL_GRANTS.attach,
          createCorrelationId, options.observeRequest, async (input, envelope) => {
            const startRow = validNativeCount(input.startRow, "startRow", true, 4_294_967_295);
            const rows = validNativeCount(input.rows, "rows", true, 4_294_967_295);
            return decodeSemanticTerminalHistory(
              await transport.history({
                ...envelope,
                input: { ...input, startRow, rows },
              }),
            );
          }),
        createAnchor: request<CreateSemanticTerminalAnchorInput, ReturnType<typeof decodeSemanticTerminalAnchor>>(
          "create-anchor", binding, active, SEMANTIC_TERMINAL_GRANTS.attach,
          createCorrelationId, options.observeRequest, async (_input, envelope) => {
            return decodeSemanticTerminalAnchor(
              await transport.anchor(envelope),
            );
          }),
        resolveAnchor: request<ResolveSemanticTerminalAnchorInput, ReturnType<typeof decodeResolvedSemanticTerminalAnchor>>(
          "resolve-anchor", binding, active, SEMANTIC_TERMINAL_GRANTS.attach,
          createCorrelationId, options.observeRequest, async (_input, envelope) => {
            return decodeResolvedSemanticTerminalAnchor(
              await transport.resolveAnchor(envelope),
            );
          }),
        releaseAnchor: request<ReleaseSemanticTerminalAnchorInput, { readonly released: boolean }>(
          "release-anchor", binding, active, SEMANTIC_TERMINAL_GRANTS.attach,
          createCorrelationId, options.observeRequest, async (_input, envelope) => {
            return {
              released: decodeBoolean(
                await transport.releaseAnchor(envelope),
                "released",
              ),
            };
          }),
        select: request<SelectSemanticTerminalInput, ReturnType<typeof decodeSemanticTerminalSelection>>(
          "select", binding, active, SEMANTIC_TERMINAL_GRANTS.attach,
          createCorrelationId, options.observeRequest, async (_input, envelope) => {
            return decodeSemanticTerminalSelection(
              await transport.select(envelope),
            );
          }),
        inspectPaste: request<InspectSemanticTerminalPasteInput, { readonly safe: boolean }>(
          "inspect-paste", binding, active, SEMANTIC_TERMINAL_GRANTS.input,
          createCorrelationId, options.observeRequest, async (_input, envelope) => ({
            safe: decodeBoolean(await transport.inspectPaste(envelope), "pasteSafety"),
          })),
        publicationStats: request<InspectSemanticTerminalPublicationInput, ReturnType<typeof decodeSemanticTerminalPublicationStats>>(
          "publication-stats", binding, active, SEMANTIC_TERMINAL_GRANTS.inspect,
          createCorrelationId, options.observeRequest, async (_input, envelope) => {
            return decodeSemanticTerminalPublicationStats(
              await transport.publicationStats(envelope),
            );
          }),
        appMemory: request<Readonly<Record<never, never>>, ReturnType<typeof decodeAppMemory>>(
          "app-memory", binding, active, SEMANTIC_TERMINAL_GRANTS.inspect,
          createCorrelationId, options.observeRequest, async (_input, envelope) =>
            decodeAppMemory(await transport.appMemory(envelope))),
        screens: Object.freeze({
          async attach(
            streamRequest: AttachSemanticTerminalScreenInput,
            listener: Parameters<SemanticTerminalsService["screens"]["attach"]>[1],
          ) {
            requireGrant(binding, SEMANTIC_TERMINAL_GRANTS.attach);
            if (!context.active) throw new Error(DISPOSED.message);
            validSafeInteger(streamRequest.initialCredit, "initialCredit", true);
            if (
              streamRequest.afterSequence !== null
              && (!Number.isSafeInteger(streamRequest.afterSequence) || streamRequest.afterSequence < 0)
            ) {
              throw new SemanticTerminalsFailure(
                SEMANTIC_TERMINALS_ERROR_CODES.invalidRequest,
                "Replay revision must be a non-negative safe integer or null",
              );
            }
            const buffered: NativeSemanticTerminalEvent[] = [];
            let bufferedFailure: unknown = null;
            let attachment: SemanticScreenAttachment | null = null;
            const deliver = (raw: unknown) => {
              try {
                const event = decodeNativeSemanticTerminalEvent(raw);
                if (attachment) attachment.observe(event);
                else buffered.push(event);
              } catch (error) {
                if (attachment) attachment.protocolFailure(error);
                else bufferedFailure = error;
              }
            };
            const attachEnvelope = transportEnvelope(binding, createCorrelationId, {
              terminalId: streamRequest.terminalId,
              claimsResize: streamRequest.claimsResize,
            });
            const native = decodeNativeSemanticTerminalAttachment(
              await transport.attach(attachEnvelope, deliver),
            );
            if (
              streamRequest.afterSequence !== null
              && streamRequest.afterSequence > native.revision
            ) {
              await transport.detach(transportEnvelope(binding, createCorrelationId, {
                attachmentId: native.attachmentId,
              })).catch(() => undefined);
              throw new SemanticTerminalsFailure(
                SEMANTIC_TERMINALS_ERROR_CODES.invalidRequest,
                "Replay revision is ahead of the semantic snapshot",
              );
            }
            attachment = new SemanticScreenAttachment(
              binding,
              native,
              streamRequest,
              transport,
              createCorrelationId,
              listener,
              () => { attachments.delete(native.attachmentId); },
            );
            attachments.set(native.attachmentId, {
              terminalId: streamRequest.terminalId,
              claimsResize: streamRequest.claimsResize,
            });
            const owned = context.own(() => attachment?.closeFromOwner());
            attachment.bindOwned(owned);
            for (const event of buffered) attachment.observe(event);
            if (bufferedFailure !== null) attachment.protocolFailure(bufferedFailure);
            return attachment;
          },
        }),
      });
    },
  };
}
