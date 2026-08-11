declare const terminalIdBrand: unique symbol;
declare const terminalAttachmentIdBrand: unique symbol;
declare const terminalViewIdBrand: unique symbol;
declare const terminalRevisionBrand: unique symbol;
declare const terminalRegistrySubscriptionIdBrand: unique symbol;

export type TerminalId = string & { readonly [terminalIdBrand]: true };
export type TerminalAttachmentId = string & {
  readonly [terminalAttachmentIdBrand]: true;
};
export type TerminalViewId = string & { readonly [terminalViewIdBrand]: true };
export type TerminalRevision = number & { readonly [terminalRevisionBrand]: true };
export type TerminalRegistrySubscriptionId = string & {
  readonly [terminalRegistrySubscriptionIdBrand]: true;
};

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type TerminalLifecycle = "starting" | "running" | "closing" | "exited";
export type TerminalExitReason =
  | "process_exit"
  | "explicit_close"
  | "host_shutdown"
  | "startup_failure";

export interface TerminalExit {
  readonly code: number | null;
  readonly reason: TerminalExitReason;
  readonly observedAtMs: number;
}

export type TerminalOwner =
  | { readonly type: "core" }
  | {
      readonly type: "module";
      readonly moduleId: string;
      readonly ownerKey: string;
      readonly moduleSessionId: string;
    };

export interface TerminalMetadata {
  readonly label: string;
  readonly cwd: string;
  readonly projectPath: string | null;
  readonly displayCommand: string;
  readonly createdAtMs: number;
  readonly owner: TerminalOwner;
  readonly ownerMetadata: JsonValue | null;
  readonly presentation: JsonValue | null;
}

export type TerminalAgentState = "idle" | "working" | "blocked";
export type TerminalAgentAttentionKind = "blocked" | "completed";

export interface TerminalAgentReportSource {
  readonly identifier: string;
  readonly version: string;
}

export interface TerminalAgentAttention {
  readonly kind: TerminalAgentAttentionKind;
  readonly revision: number;
}

export interface TerminalAgentActivity {
  readonly revision: number;
  readonly state: TerminalAgentState;
  readonly message: string | null;
  readonly updatedAtMs: number;
  readonly source: TerminalAgentReportSource;
  readonly attention: TerminalAgentAttention | null;
}

export interface TerminalDescriptor {
  readonly id: TerminalId;
  readonly revision: TerminalRevision;
  readonly lifecycle: TerminalLifecycle;
  readonly exit: TerminalExit | null;
  readonly metadata: TerminalMetadata;
  readonly columns: number;
  readonly rows: number;
  readonly lastOutputAtMs: number | null;
  readonly agentActivity: TerminalAgentActivity | null;
}

export type TerminalRegistryEvent =
  | {
      readonly event: "upserted";
      readonly descriptor: TerminalDescriptor;
    }
  | {
      readonly event: "removed";
      readonly terminalId: TerminalId;
    };

export interface TerminalColorTheme {
  readonly foreground: string;
  readonly background: string;
  readonly palette: readonly string[];
}

export interface TerminalLaunchRequest {
  readonly target: TerminalLaunchTarget;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly columns: number;
  readonly rows: number;
  readonly colorTheme: TerminalColorTheme;
  readonly metadata: TerminalMetadata;
}

export interface TerminalReplay {
  readonly revision: TerminalRevision;
  readonly columns: number;
  readonly rows: number;
  readonly bytes: readonly number[];
}

export interface TerminalRuntimeSnapshot {
  readonly descriptor: TerminalDescriptor;
  readonly sequenceBoundary: number;
  /** The byte path's baseline. Legacy; area 05 deletes it. */
  readonly replay: TerminalReplay;
  /**
   * The semantic path's baseline: the host's state at `sequenceBoundary`, at
   * the revision the descriptor reports. Null on the byte path, and never
   * absent, so a client never has to decide what a missing field meant.
   */
  readonly state: TerminalScreenState | null;
}

export interface TerminalAttachment {
  readonly attachmentId: TerminalAttachmentId;
  readonly live: boolean;
  readonly snapshot: TerminalRuntimeSnapshot;
}

export interface TerminalCloseResult {
  readonly existed: boolean;
  readonly exit: TerminalExit | null;
}

/**
 * What a close did to the frontend projection.
 *
 * `unconfirmed` means the host accepted the close but its removal has not been
 * observed. The projection is left untouched: a removal is published by the
 * host, never synthesized here.
 */
export type TerminalCloseOutcome =
  | { readonly status: "closed" }
  | { readonly status: "unconfirmed"; readonly terminalId: TerminalId };

/**
 * What happened to one submitted keystroke.
 *
 * `unavailable` is the expected result of racing an exit, a close, or a
 * recovery: the terminal took no input and nothing failed. `failed` is a real
 * transport, validation, or host I/O failure and is the only error to report.
 */
export type TerminalInputOutcome =
  | { readonly status: "accepted" }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "failed"; readonly error: unknown };

/**
 * Which encoding of a terminal an attachment asks the host for.
 *
 * The authority is `TerminalTransport` in `core/backend/src/terminal/types.rs`.
 * It is the sole migration switch, not a preference: nothing reads it from
 * configuration, and area 05 deletes it with the encoding it names.
 */
export type TerminalTransport = "legacy" | "semantic";

/**
 * The coordinate space a point is named in.
 *
 * The same cell has a different number in each space, and which one is meant is
 * never guessable from the number alone, so every coordinate that crosses this
 * boundary says which space it belongs to.
 */
export type TerminalProjectedSpace = "active" | "viewport" | "screen" | "history";

/** A cell coordinate in one of those spaces. */
export interface TerminalProjectedPoint {
  readonly column: number;
  readonly row: number;
}

/**
 * The name the host minted for one anchored cell.
 *
 * A number and nothing else: the parser's tracked reference stays in the host,
 * so a stale handle is answered rather than dereferenced. The authority is
 * `TerminalAnchorId` in `core/backend/src/terminal/projection.rs`.
 */
export type TerminalAnchorId = number;

/** How the end of a selection moves when no cell is named. */
export type TerminalSelectionMove =
  | "left"
  | "right"
  | "up"
  | "down"
  | "home"
  | "end"
  | "page_up"
  | "page_down"
  | "beginning_of_line"
  | "end_of_line";

/**
 * What a client asks the host to select.
 *
 * An intent, never a set of cells: which cells an intent covers depends on
 * where rows wrap, where a word ends, where the OSC 133 marks are and where
 * history begins — all of which the host holds. A client that named cells would
 * be the second authority on the screen.
 */
export type TerminalSelectionRequest =
  | {
      readonly kind: "range";
      readonly space: TerminalProjectedSpace;
      readonly from: TerminalProjectedPoint;
      readonly to: TerminalProjectedPoint;
      /** Column-bounded rather than line-following. */
      readonly rectangle: boolean;
    }
  | { readonly kind: "word"; readonly space: TerminalProjectedSpace; readonly at: TerminalProjectedPoint }
  | { readonly kind: "line"; readonly space: TerminalProjectedSpace; readonly at: TerminalProjectedPoint }
  | { readonly kind: "output"; readonly space: TerminalProjectedSpace; readonly at: TerminalProjectedPoint }
  | { readonly kind: "all" }
  | { readonly kind: "extend"; readonly movement: TerminalSelectionMove }
  | { readonly kind: "clear" };

/**
 * What the host holds after a selection request.
 *
 * The text comes with the answer because the host is the only place that can
 * produce it: unwrapping a wrapped line and dropping the spacer half of a wide
 * grapheme are its facts.
 */
export interface TerminalSelectionState {
  readonly active: boolean;
  readonly text: string | null;
}

/**
 * The host's terminal state, as the semantic path carries it.
 *
 * The authority is `TerminalProjection` in
 * `core/backend/src/terminal/projection.rs`. This type names the facts the
 * decoder checks on the way in; the rows and cells below them are the client
 * model's to read, and are typed where that model consumes them.
 */
export interface TerminalScreenState {
  readonly columns: number;
  readonly rows: number;
  readonly screen: string;
  readonly scrollbackRows: number;
  readonly cursor: Record<string, unknown>;
  readonly modes: Record<string, unknown>;
  readonly colors: Record<string, unknown>;
  /** What changed since the host's previous read. */
  readonly damage: Record<string, unknown>;
  readonly viewport: readonly unknown[];
}

/**
 * One thing that happened during a parse and is not screen state.
 *
 * The authority is `TerminalEffect` in
 * `core/backend/src/terminal/effects.rs`. The decoder checks the tag and keeps
 * the payload as the host sent it, because the client that acts on a title, a
 * bell, or a notification is the one that knows what each payload needs.
 */
export interface TerminalEffect {
  readonly kind: string;
  readonly [field: string]: unknown;
}

export type TerminalEvent =
  | {
      readonly event: "output";
      readonly sequence: number;
      readonly revision: TerminalRevision;
      readonly data: readonly number[];
    }
  | {
      readonly event: "replay";
      readonly sequence: number;
      readonly replay: TerminalReplay;
    }
  | {
      readonly event: "screen";
      readonly sequence: number;
      readonly revision: TerminalRevision;
      readonly state: TerminalScreenState;
      readonly effects: readonly TerminalEffect[];
    }
  | {
      readonly event: "metadata_changed";
      readonly sequence: number;
      readonly descriptor: TerminalDescriptor;
    }
  | {
      readonly event: "agent_activity_changed";
      readonly sequence: number;
      readonly descriptor: TerminalDescriptor;
    }
  | {
      readonly event: "exited";
      readonly sequence: number;
      readonly descriptor: TerminalDescriptor;
    }
  | {
      readonly event: "resync_required" | "detached";
      readonly sequence: number;
      readonly reason: string;
    };

export type TerminalLaunchTarget =
  | {
      readonly type: "shell";
      readonly executable?: string | null;
    }
  | {
      readonly type: "shell_command";
      readonly executable?: string | null;
      readonly source: string;
    }
  | {
      readonly type: "program";
      readonly program: string;
      readonly argv: readonly string[];
    };

export function defaultTerminalViewId(id: TerminalId): TerminalViewId {
  return `terminal:${id}` as TerminalViewId;
}

/** Reject values that JSON transport cannot represent faithfully. */
export function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueInner(value, new Set<object>());
}

function isJsonValueInner(value: unknown, ancestors: Set<object>): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValueInner(item, nextAncestors));
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((item) => isJsonValueInner(item, nextAncestors));
}
