import {
  TERMINAL_SESSION_GRANTS,
  TERMINAL_SESSIONS_ERROR_CODES,
  terminalSessionsService,
  type AttachTerminalBytesInput,
  type TerminalByteFrame,
  type TerminalSessionGrant,
  type TerminalSessionsErrorCode,
  type TerminalSessionsService,
} from "../protocol/terminalSessions.ts";
import type {
  ModuleTerminalId,
  ModuleTerminalSession,
  ModuleTerminalSessionLifecycleEvent,
} from "../protocol/services.ts";
import type {
  SemanticOwnedLease,
  SemanticServiceError,
  SemanticStreamAttachment,
  SemanticStreamDelivery,
} from "../protocol/semanticServices.ts";
import type {
  SemanticServiceProvider,
  SemanticServiceProviderContext,
} from "../host/semanticServices.ts";
import type { TerminalDriverId } from "../protocol/terminalHost.ts";

import {
  createFakeRequestOperation,
  TestEventSource,
  TestOrderedStreamSource,
  type FakeRequestTrace,
} from "./semanticServices.ts";

export type FakeTerminalSessionsOperation =
  | "dimensions"
  | "inspect"
  | "start"
  | "update"
  | "focus"
  | "stop"
  | "input"
  | "resize";

export interface FakeTerminalSessionsTrace {
  readonly operation: FakeTerminalSessionsOperation;
  readonly request: FakeRequestTrace<unknown>;
}

export type FakeTerminalSessionsHistoryEntry =
  | { readonly type: "focus"; readonly activationId: string; readonly sessionId: string }
  | {
      readonly type: "input";
      readonly activationId: string;
      readonly terminalId: string;
      readonly attachmentId: string;
      readonly source: "key" | "paste";
      readonly bytes: readonly number[];
    }
  | {
      readonly type: "resize";
      readonly activationId: string;
      readonly terminalId: string;
      readonly attachmentId: string;
      readonly columns: number;
      readonly rows: number;
    }
  | {
      readonly type: "exit";
      readonly terminalId: string;
      readonly exitCode: number | null;
    }
  | {
      readonly type: "attachment-disposed";
      readonly activationId: string;
      readonly terminalId: string;
      readonly attachmentId: string;
    };

export interface FakeTerminalSeed {
  readonly session: ModuleTerminalSession;
  readonly driverId: TerminalDriverId;
}

export interface FakeTerminalSessionsProviderOptions {
  readonly columns?: number;
  readonly rows?: number;
  readonly deniedGrants?: readonly TerminalSessionGrant[];
  readonly seeds?: readonly FakeTerminalSeed[];
  readonly traces?: FakeTerminalSessionsTrace[];
  readonly history?: FakeTerminalSessionsHistoryEntry[];
}

interface FakeAttachmentOwner {
  readonly activationId: string;
  readonly terminalId: string;
  readonly claimsResize: boolean;
}

interface FakeBinding {
  readonly context: SemanticServiceProviderContext;
  readonly lifecycle: TestEventSource<"activation", ModuleTerminalSessionLifecycleEvent>;
  readonly streams: Map<string, TestOrderedStreamSource<TerminalByteFrame>>;
}

class FakeTerminalSessionsFailure extends Error {
  readonly code: TerminalSessionsErrorCode;

  constructor(code: TerminalSessionsErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

const CANCELLED = {
  code: TERMINAL_SESSIONS_ERROR_CODES.cancelled,
  message: "Terminal session request was cancelled",
  retryable: false,
} as const;

const DISPOSED = {
  code: TERMINAL_SESSIONS_ERROR_CODES.activationDisposed,
  message: "The module activation is no longer active",
  retryable: false,
} as const;

function failedError(error: unknown): SemanticServiceError<TerminalSessionsErrorCode> {
  if (error instanceof FakeTerminalSessionsFailure) {
    return { code: error.code, message: error.message, retryable: false };
  }
  return {
    code: TERMINAL_SESSIONS_ERROR_CODES.transportFailed,
    message: "The fake terminal session request failed",
    retryable: false,
  };
}

function requireGrant(
  options: FakeTerminalSessionsProviderOptions,
  grant: TerminalSessionGrant,
): void {
  if (options.deniedGrants?.includes(grant)) {
    throw new FakeTerminalSessionsFailure(
      TERMINAL_SESSIONS_ERROR_CODES.denied,
      `Terminal grant ${grant} was denied`,
    );
  }
}

function dimensions(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 65_535) {
    throw new Error("Fake terminal dimensions must fit the native unsigned 16-bit range");
  }
  return resolved;
}

/** Mutable Tauri-free terminal host used by module workflow tests. */
export class FakeTerminalSessionsHost {
  readonly #options: FakeTerminalSessionsProviderOptions;
  readonly #sessions = new Map<string, ModuleTerminalSession>();
  readonly #drivers = new Map<string, TerminalDriverId>();
  readonly #bindings = new Set<FakeBinding>();
  readonly #attachments = new Map<string, FakeAttachmentOwner>();
  #nextSession = 1;

  constructor(options: FakeTerminalSessionsProviderOptions = {}) {
    this.#options = options;
    for (const seed of options.seeds ?? []) {
      this.#sessions.set(seed.session.id, seed.session);
      this.#drivers.set(seed.session.terminalId, seed.driverId);
    }
  }

  provider(): SemanticServiceProvider<TerminalSessionsService> {
    return {
      service: terminalSessionsService,
      bind: (context) => this.#bind(context),
    };
  }

  sessions(): readonly ModuleTerminalSession[] {
    return [...this.#sessions.values()];
  }

  async appendOutput(terminalId: string, bytes: Uint8Array): Promise<void> {
    await Promise.all([...this.#bindings].flatMap((binding) => {
      const stream = binding.streams.get(terminalId);
      return stream ? [stream.append({ bytes: bytes.slice() })] : [];
    }));
  }

  async exit(terminalId: string, exitCode: number | null): Promise<void> {
    const session = this.#sessionByTerminal(terminalId);
    this.#options.history?.push({ type: "exit", terminalId, exitCode });
    if (!session) return;
    await this.#publish(session.moduleId, {
      type: "exited",
      session,
      reason: exitCode === 0 ? "zero-exit" : "nonzero-exit",
      exitCode,
    });
    for (const binding of this.#bindings) {
      const stream = binding.streams.get(terminalId);
      if (stream) await stream.disconnect("terminal-exited", false);
    }
  }

  #bind(context: SemanticServiceProviderContext): TerminalSessionsService {
    const lifecycle = new TestEventSource<"activation", ModuleTerminalSessionLifecycleEvent>(
      context,
      "shipctl.terminal-sessions.lifecycle",
      (left, right) => left === right,
    );
    const binding: FakeBinding = { context, lifecycle, streams: new Map() };
    this.#bindings.add(binding);
    context.own(() => { this.#bindings.delete(binding); });

    const operation = <Input, Output>(
      name: FakeTerminalSessionsOperation,
      grant: TerminalSessionGrant | null,
      handle: (input: Input) => Output | Promise<Output>,
    ) => {
      const traces: FakeRequestTrace<Input>[] = [];
      const request = createFakeRequestOperation<Input, Output, TerminalSessionsErrorCode>({
        context,
        policy: POLICY,
        handle: ({ input }) => {
          if (grant) requireGrant(this.#options, grant);
          return handle(input);
        },
        failedError,
        cancelledError: CANCELLED,
        disposedError: DISPOSED,
        trace: traces,
      });
      return Object.freeze({
        policy: request.policy,
        async execute(input: Input, requestOptions?: Parameters<typeof request.execute>[1]) {
          const count = traces.length;
          const outcome = await request.execute(input, requestOptions);
          const captured = traces[count];
          if (captured) {
            thisOptions.traces?.push({ operation: name, request: captured });
          }
          return outcome;
        },
      });
    };
    const thisOptions = this.#options;

    const ownSession = (sessionId: string): ModuleTerminalSession => {
      const session = this.#sessions.get(sessionId);
      if (!session || session.moduleId !== context.activation.moduleId) {
        throw new FakeTerminalSessionsFailure(
          TERMINAL_SESSIONS_ERROR_CODES.notFound,
          "The terminal session is not owned by this activation",
        );
      }
      return session;
    };

    return Object.freeze({
      dimensions: operation("dimensions", null, () => ({
        columns: dimensions(this.#options.columns, 80),
        rows: dimensions(this.#options.rows, 24),
      })),
      inspectSessions: operation("inspect", TERMINAL_SESSION_GRANTS.attach, (input) => {
        if ((input as { owner?: unknown }).owner !== "activation") {
          throw new FakeTerminalSessionsFailure(
            TERMINAL_SESSIONS_ERROR_CODES.invalidRequest,
            "Terminal inspection scope is invalid",
          );
        }
        return this.sessions().filter(({ moduleId }) => moduleId === context.activation.moduleId);
      }),
      startSession: operation("start", TERMINAL_SESSION_GRANTS.start, async (input) => {
        if (!input.moduleSessionId || !input.ownerKey || !input.command || !input.cwd) {
          throw new FakeTerminalSessionsFailure(
            TERMINAL_SESSIONS_ERROR_CODES.invalidRequest,
            "Terminal launch fields cannot be empty",
          );
        }
        const id = `fake-session-${this.#nextSession}`;
        this.#nextSession += 1;
        const session: ModuleTerminalSession = {
          id,
          terminalId: `fake-terminal-${id}` as ModuleTerminalId,
          moduleId: context.activation.moduleId,
          projectPath: input.projectPath,
          ownerKey: input.ownerKey,
          label: input.label,
          ownerMetadata: input.ownerMetadata,
          presentation: input.presentation,
        };
        this.#sessions.set(id, session);
        this.#drivers.set(session.terminalId, "semantic-terminal" as TerminalDriverId);
        await this.#publish(session.moduleId, { type: "launched", session });
        return session;
      }),
      updateSession: operation("update", TERMINAL_SESSION_GRANTS.start, async (input) => {
        const current = ownSession(input.sessionId);
        const session = { ...current, ...input.patch };
        this.#sessions.set(session.id, session);
        await this.#publish(session.moduleId, { type: "updated", session });
        return session;
      }),
      focusSession: operation("focus", TERMINAL_SESSION_GRANTS.attach, (input) => {
        const session = ownSession(input.sessionId);
        this.#options.history?.push({
          type: "focus",
          activationId: context.activation.activationId,
          sessionId: session.id,
        });
        return session;
      }),
      stopSession: operation("stop", TERMINAL_SESSION_GRANTS.stop, async (input) => {
        const session = ownSession(input.sessionId);
        this.#sessions.delete(session.id);
        await this.#publish(session.moduleId, { type: "closed", session });
        return session;
      }),
      writeInput: operation("input", TERMINAL_SESSION_GRANTS.input, (input) => {
        if (!(input.bytes instanceof Uint8Array)) {
          throw new FakeTerminalSessionsFailure(
            TERMINAL_SESSIONS_ERROR_CODES.invalidRequest,
            "Terminal input must contain exact bytes",
          );
        }
        const attachment = this.#attachments.get(input.attachmentId);
        if (
          !attachment
          || attachment.activationId !== context.activation.activationId
          || attachment.terminalId !== input.terminalId
        ) {
          throw new FakeTerminalSessionsFailure(
            TERMINAL_SESSIONS_ERROR_CODES.denied,
            "The activation does not own the terminal input attachment",
          );
        }
        this.#options.history?.push({
          type: "input",
          activationId: context.activation.activationId,
          terminalId: input.terminalId,
          attachmentId: input.attachmentId,
          source: input.source,
          bytes: [...input.bytes],
        });
        return {};
      }),
      resize: operation("resize", TERMINAL_SESSION_GRANTS.resize, (input) => {
        const attachment = this.#attachments.get(input.attachmentId);
        if (
          !attachment
          || attachment.activationId !== context.activation.activationId
          || attachment.terminalId !== input.terminalId
          || !attachment.claimsResize
        ) {
          throw new FakeTerminalSessionsFailure(
            TERMINAL_SESSIONS_ERROR_CODES.denied,
            "The activation does not own resize authority for this terminal",
          );
        }
        dimensions(input.columns, input.columns);
        dimensions(input.rows, input.rows);
        this.#options.history?.push({
          type: "resize",
          activationId: context.activation.activationId,
          terminalId: input.terminalId,
          attachmentId: input.attachmentId,
          columns: input.columns,
          rows: input.rows,
        });
        return {};
      }),
      lifecycle: Object.freeze({
        async subscribe(scope, listener) {
          requireGrant(thisOptions, TERMINAL_SESSION_GRANTS.attach);
          if (scope.owner !== "activation") {
            throw new Error("Terminal lifecycle scope is invalid");
          }
          return lifecycle.subscribe("activation", listener);
        },
      }),
      bytes: Object.freeze({
        attach: (request, listener) => this.#attachBytes(binding, request, listener),
      }),
    });
  }

  async #attachBytes(
    binding: FakeBinding,
    request: AttachTerminalBytesInput,
    listener: (delivery: SemanticStreamDelivery<TerminalByteFrame>) => void | Promise<void>,
  ): Promise<SemanticStreamAttachment> {
    requireGrant(this.#options, TERMINAL_SESSION_GRANTS.attach);
    const driver = this.#drivers.get(request.terminalId);
    if (!driver || driver !== request.driverId) {
      throw new FakeTerminalSessionsFailure(
        TERMINAL_SESSIONS_ERROR_CODES.notFound,
        "The terminal or selected driver is unavailable",
      );
    }
    let stream = binding.streams.get(request.terminalId);
    if (!stream) {
      stream = new TestOrderedStreamSource(binding.context, 0);
      binding.streams.set(request.terminalId, stream);
    }
    let tracking: SemanticOwnedLease | null = null;
    const attachment = await stream.attach(request, async (delivery) => {
      await listener(delivery);
      if (delivery.type === "disconnected") await tracking?.dispose();
    });
    const owner: FakeAttachmentOwner = {
      activationId: binding.context.activation.activationId,
      terminalId: request.terminalId,
      claimsResize: request.claimsResize,
    };
    this.#attachments.set(attachment.id, owner);
    tracking = binding.context.own(() => {
      if (this.#attachments.get(attachment.id) === owner) {
        this.#attachments.delete(attachment.id);
        this.#options.history?.push({
          type: "attachment-disposed",
          activationId: owner.activationId,
          terminalId: owner.terminalId,
          attachmentId: attachment.id,
        });
      }
    });
    let disposed = false;
    return Object.freeze({
      id: attachment.id,
      activation: attachment.activation,
      get disposed() { return disposed || attachment.disposed; },
      get acknowledgedSequence() { return attachment.acknowledgedSequence; },
      grant: (credit: number) => attachment.grant(credit),
      acknowledge: (sequence: number) => attachment.acknowledge(sequence),
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await tracking?.dispose();
        await attachment.dispose();
      },
    });
  }

  #sessionByTerminal(terminalId: string): ModuleTerminalSession | null {
    return this.sessions().find((session) => session.terminalId === terminalId) ?? null;
  }

  async #publish(moduleId: string, event: ModuleTerminalSessionLifecycleEvent): Promise<void> {
    await Promise.all([...this.#bindings].flatMap((binding) =>
      binding.context.active && binding.context.activation.moduleId === moduleId
        ? [binding.lifecycle.publish("activation", event)]
        : []));
  }
}

/** Tauri-free terminal-session provider with an inspectable deterministic host. */
export function createFakeTerminalSessionsServiceProvider(
  options: FakeTerminalSessionsProviderOptions = {},
): { readonly provider: SemanticServiceProvider<TerminalSessionsService>; readonly host: FakeTerminalSessionsHost } {
  const host = new FakeTerminalSessionsHost(options);
  return { provider: host.provider(), host };
}
