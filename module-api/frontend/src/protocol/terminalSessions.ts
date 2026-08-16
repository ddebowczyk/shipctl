import { defineSemanticService } from "./semanticServices.ts";
import type {
  SemanticEventSource,
  SemanticRequestOperation,
  SemanticStreamAttachment,
  SemanticStreamAttachRequest,
  SemanticStreamDelivery,
} from "./semanticServices.ts";
import type {
  ModuleTerminalDimensions,
  ModuleTerminalSession,
  ModuleTerminalSessionLaunchRequest,
  ModuleTerminalSessionLifecycleEvent,
  ModuleTerminalSessionUpdate,
} from "./services.ts";
import type { TerminalDriverId } from "./terminalHost.ts";

export const TERMINAL_SESSION_GRANTS = {
  start: "terminal.start",
  attach: "terminal.attach",
  input: "terminal.input",
  resize: "terminal.resize",
  stop: "terminal.stop",
} as const;

export type TerminalSessionGrant =
  (typeof TERMINAL_SESSION_GRANTS)[keyof typeof TERMINAL_SESSION_GRANTS];

export const TERMINAL_SESSIONS_ERROR_CODES = {
  invalidRequest: "terminal-sessions.request.invalid",
  cancelled: "terminal-sessions.request.cancelled",
  activationDisposed: "terminal-sessions.activation.disposed",
  denied: "terminal-sessions.activation.denied",
  notFound: "terminal-sessions.session.not-found",
  unavailable: "terminal-sessions.session.unavailable",
  transportFailed: "terminal-sessions.transport.failed",
} as const;

export type TerminalSessionsErrorCode =
  (typeof TERMINAL_SESSIONS_ERROR_CODES)[keyof typeof TERMINAL_SESSIONS_ERROR_CODES];

export interface InspectTerminalSessionsInput {
  /** A module can inspect only sessions owned by its current activation identity. */
  readonly owner: "activation";
}

/** The module identity is supplied by the activation, never by this request. */
export type StartTerminalSessionInput = ModuleTerminalSessionLaunchRequest;

export interface UpdateTerminalSessionInput {
  readonly sessionId: string;
  readonly patch: ModuleTerminalSessionUpdate;
}

export interface FocusTerminalSessionInput {
  readonly sessionId: string;
}

export interface StopTerminalSessionInput {
  readonly sessionId: string;
}

export interface WriteTerminalInput {
  readonly terminalId: string;
  /** The live presentation attachment that owns this input path. */
  readonly attachmentId: string;
  /** Distinguishes a paste workflow from key input without changing the PTY bytes. */
  readonly source: "key" | "paste";
  readonly bytes: Uint8Array;
}

export interface ResizeTerminalInput {
  readonly terminalId: string;
  /** The attachment which currently owns resize authority. */
  readonly attachmentId: string;
  readonly columns: number;
  readonly rows: number;
}

export interface AttachTerminalBytesInput extends SemanticStreamAttachRequest {
  readonly terminalId: string;
  readonly driverId: TerminalDriverId;
  readonly claimsResize: boolean;
}

export interface TerminalByteFrame {
  readonly bytes: Uint8Array;
}

/**
 * Exact ordered PTY output. Raw terminal bytes have no replay snapshot. When
 * `afterSequence` precedes the live boundary, the stream reports a gap before
 * it starts live delivery.
 */
export interface TerminalByteStream {
  attach(
    request: AttachTerminalBytesInput,
    listener: (delivery: SemanticStreamDelivery<TerminalByteFrame>) => void | Promise<void>,
  ): Promise<SemanticStreamAttachment>;
}

export interface TerminalSessionLifecycleScope {
  readonly owner: "activation";
}

export interface TerminalSessionsService {
  readonly dimensions: SemanticRequestOperation<
    Readonly<Record<never, never>>,
    ModuleTerminalDimensions,
    TerminalSessionsErrorCode
  >;
  readonly inspectSessions: SemanticRequestOperation<
    InspectTerminalSessionsInput,
    readonly ModuleTerminalSession[],
    TerminalSessionsErrorCode
  >;
  readonly startSession: SemanticRequestOperation<
    StartTerminalSessionInput,
    ModuleTerminalSession,
    TerminalSessionsErrorCode
  >;
  readonly updateSession: SemanticRequestOperation<
    UpdateTerminalSessionInput,
    ModuleTerminalSession,
    TerminalSessionsErrorCode
  >;
  readonly focusSession: SemanticRequestOperation<
    FocusTerminalSessionInput,
    ModuleTerminalSession,
    TerminalSessionsErrorCode
  >;
  readonly stopSession: SemanticRequestOperation<
    StopTerminalSessionInput,
    ModuleTerminalSession,
    TerminalSessionsErrorCode
  >;
  readonly writeInput: SemanticRequestOperation<
    WriteTerminalInput,
    Readonly<Record<never, never>>,
    TerminalSessionsErrorCode
  >;
  readonly resize: SemanticRequestOperation<
    ResizeTerminalInput,
    Readonly<Record<never, never>>,
    TerminalSessionsErrorCode
  >;
  readonly lifecycle: SemanticEventSource<
    TerminalSessionLifecycleScope,
    ModuleTerminalSessionLifecycleEvent
  >;
  readonly bytes: TerminalByteStream;
}

/** Activation-owned access to host PTYs and their replaceable attachments. */
export const terminalSessionsService = defineSemanticService<TerminalSessionsService>(
  "shipctl.terminal-sessions",
  1,
);
