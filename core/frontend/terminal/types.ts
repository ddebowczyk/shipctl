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
  readonly replay: TerminalReplay;
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
