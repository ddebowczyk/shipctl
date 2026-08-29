import { defineSemanticService } from "./semanticServices.ts";
import type {
  SemanticEventSource,
  SemanticRequestOperation,
} from "./semanticServices";
import type {
  ModuleJsonValue,
  ModuleTerminalColorTheme,
  ModuleTerminalId,
} from "./services";

declare const assistantSessionIdBrand: unique symbol;
declare const assistantProviderIdBrand: unique symbol;

/** Host-owned durable identity for one recoverable assistant session. */
export type AssistantSessionId = string & {
  readonly [assistantSessionIdBrand]: true;
};

/**
 * A plugin-owned semantic label for a launch policy. It is data persisted with
 * a recovery record, never an executable allowlist owned by the native host.
 */
export type AssistantProviderId = string & {
  readonly [assistantProviderIdBrand]: true;
};

export function assistantSessionId(value: string): AssistantSessionId {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error("Assistant session identity cannot be empty");
  return normalized as AssistantSessionId;
}

export function assistantProviderId(value: string): AssistantProviderId {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(normalized)) {
    throw new Error("Assistant provider identity is invalid");
  }
  return normalized as AssistantProviderId;
}

/** Opaque plugin policy data, validated only as bounded durable text by the host. */
export type AssistantSessionMode = string;
export type AssistantIdentityState = "pending" | "assigned" | "ready" | "failed";

/**
 * A generic launch description. A captured-session-id placeholder is resolved
 * only by the host during resume, so a plugin never receives a persisted
 * private provider identity back from the recovery manifest.
 */
export type AssistantProcessArgument = string | {
  readonly kind: "captured-session-id";
};

export interface AssistantProcessLaunch {
  readonly program: string;
  readonly arguments: readonly AssistantProcessArgument[];
}

/**
 * Host-owned recovery metadata. The provider's private session identifier is
 * deliberately absent: plugins address records only through `recordId`.
 */
export interface AssistantRecoveryRecord extends Readonly<Record<string, ModuleJsonValue>> {
  readonly recordId: AssistantSessionId;
  readonly provider: AssistantProviderId;
  readonly launchRepoPath: string;
  readonly placementProjectPath: string;
  readonly label: string;
  readonly sessionMode: AssistantSessionMode;
  readonly model: string | null;
  readonly captureState: AssistantIdentityState;
  readonly restoreOnNextLaunch: boolean;
  readonly startedAt: number;
  readonly updatedAt: number;
}

/** Terminal facts supplied by the host-managed terminal start transaction. */
export interface AssistantTerminalStartContext {
  readonly moduleSessionId: string;
  readonly columns: number;
  readonly rows: number;
  readonly environment: Readonly<Record<string, string>>;
  readonly colorTheme: ModuleTerminalColorTheme;
}

export interface StartAssistantSessionInput {
  readonly provider: AssistantProviderId;
  readonly launchRepoPath: string;
  readonly placementProjectPath: string;
  readonly label: string;
  readonly sessionMode: AssistantSessionMode;
  readonly model?: string;
  readonly launch: AssistantProcessLaunch;
  /**
   * A plugin may assign identity before process start when its own policy
   * supports it. The host stores it as opaque bounded text and marks the
   * record assigned until the plugin confirms that the provider persisted it.
   */
  readonly initialSessionIdentity?: string;
  readonly terminal: AssistantTerminalStartContext;
}

export interface ResumeAssistantSessionInput {
  readonly recordId: AssistantSessionId;
  readonly launch: AssistantProcessLaunch;
  readonly terminal: AssistantTerminalStartContext;
}

export interface StartedAssistantSession {
  readonly terminalId: ModuleTerminalId;
  readonly record: AssistantRecoveryRecord;
}

export interface AssistantSessionInput {
  readonly recordId: AssistantSessionId;
}

export interface RecordAssistantSessionIdentityInput extends AssistantSessionInput {
  readonly providerSessionId: string;
}

export interface RecordAssistantPlacementInput extends AssistantSessionInput {
  readonly placementProjectPath: string;
}

export interface RecordAssistantLabelInput extends AssistantSessionInput {
  readonly label: string;
}

/** A bounded read rooted at the current user's home directory. */
export type AssistantResourceReadRequest =
  | {
    readonly kind: "file";
    readonly resourceId: string;
    readonly relativePath: string;
    readonly maxBytes?: number;
    /** Read only the first UTF-8 line within maxBytes. */
    readonly firstLineOnly?: boolean;
  }
  | {
    readonly kind: "tree";
    readonly resourceId: string;
    readonly relativePath: string;
    readonly maxFiles?: number;
    readonly maxBytesPerFile?: number;
    readonly extensions?: readonly string[];
    /** Return bounded paths with empty content without reading file bodies. */
    readonly metadataOnly?: boolean;
  };

export interface AssistantResourceReadInput {
  readonly request: AssistantResourceReadRequest;
}

export interface AssistantResourceFile {
  readonly relativePath: string;
  readonly content: string;
}

export type AssistantResourceReadResult =
  | {
    readonly kind: "file";
    readonly resourceId: string;
    readonly content: string;
  }
  | {
    readonly kind: "tree";
    readonly resourceId: string;
    readonly files: readonly AssistantResourceFile[];
  };

/** A bounded UTF-8 write rooted at the current user's home directory. */
export interface AssistantResourceWriteInput {
  readonly resourceId: string;
  readonly relativePath: string;
  readonly content: string;
}

/**
 * A generic bounded request/response completion condition for a process that
 * stays alive after emitting its response. The host recognizes only a JSONL
 * correlation id; interpretation of the matched response remains plugin code.
 */
export type AssistantResourceExecuteCompletion = {
  readonly kind: "jsonl-response-id";
  readonly id: string | number;
};

export interface AssistantResourceExecuteInput {
  readonly resourceId: string;
  readonly program: string;
  readonly arguments: readonly string[];
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly completion?: AssistantResourceExecuteCompletion;
}

export interface AssistantResourceExecuteResult {
  readonly resourceId: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

export interface AssistantSessionObservationScope {
  readonly recordId?: AssistantSessionId;
  readonly projectPath?: string;
}

export type AssistantSessionChangeKind =
  | "started"
  | "resumed"
  | "identity-updated"
  | "identity-failed"
  | "placement-recorded"
  | "label-recorded"
  | "discarded"
  | "rearmed";

export interface AssistantSessionChanged {
  readonly kind: AssistantSessionChangeKind;
  readonly recordId: AssistantSessionId;
  readonly projectPath: string;
  readonly record: AssistantRecoveryRecord | null;
}

export type AssistantLaunchGrant =
  | "assistant.launch"
  | "assistant.session-record"
  | "assistant.resource.read"
  | "assistant.resource.write"
  | "assistant.resource.execute";

export const ASSISTANT_LAUNCH_GRANTS = Object.freeze({
  launch: "assistant.launch",
  sessionRecord: "assistant.session-record",
  resourceRead: "assistant.resource.read",
  resourceWrite: "assistant.resource.write",
  resourceExecute: "assistant.resource.execute",
} as const satisfies Readonly<Record<string, AssistantLaunchGrant>>);

export type AssistantLaunchErrorCode =
  | "assistant-launch.transport-failed"
  | "assistant-launch.denied"
  | "assistant-launch.invalid-request"
  | "assistant-launch.invalid-response"
  | "assistant-launch.unavailable"
  | "assistant-launch.launch-failed"
  | "assistant-launch.session-not-found"
  | "assistant-launch.session-not-recoverable"
  | "assistant-launch.cancelled"
  | "assistant-launch.activation-disposed";

export interface AssistantLaunchService {
  readonly startSession: SemanticRequestOperation<
    StartAssistantSessionInput,
    StartedAssistantSession,
    AssistantLaunchErrorCode
  >;
  readonly resumeSession: SemanticRequestOperation<
    ResumeAssistantSessionInput,
    StartedAssistantSession,
    AssistantLaunchErrorCode
  >;
  readonly recordSessionIdentity: SemanticRequestOperation<
    RecordAssistantSessionIdentityInput,
    AssistantRecoveryRecord,
    AssistantLaunchErrorCode
  >;
  readonly markSessionIdentityFailed: SemanticRequestOperation<
    AssistantSessionInput,
    AssistantRecoveryRecord,
    AssistantLaunchErrorCode
  >;
  readonly recordSessionPlacement: SemanticRequestOperation<
    RecordAssistantPlacementInput,
    AssistantRecoveryRecord,
    AssistantLaunchErrorCode
  >;
  readonly recordSessionLabel: SemanticRequestOperation<
    RecordAssistantLabelInput,
    AssistantRecoveryRecord,
    AssistantLaunchErrorCode
  >;
  readonly discardSession: SemanticRequestOperation<
    AssistantSessionInput,
    void,
    AssistantLaunchErrorCode
  >;
  readonly rearmSession: SemanticRequestOperation<
    AssistantSessionInput,
    void,
    AssistantLaunchErrorCode
  >;
  readonly inspectRestorableSessions: SemanticRequestOperation<
    Readonly<Record<never, never>>,
    readonly AssistantRecoveryRecord[],
    AssistantLaunchErrorCode
  >;
  readonly takeStartupWarning: SemanticRequestOperation<
    Readonly<Record<never, never>>,
    string | null,
    AssistantLaunchErrorCode
  >;
  readonly prepareForShutdown: SemanticRequestOperation<
    Readonly<Record<never, never>>,
    void,
    AssistantLaunchErrorCode
  >;
  readonly readResource: SemanticRequestOperation<
    AssistantResourceReadInput,
    AssistantResourceReadResult,
    AssistantLaunchErrorCode
  >;
  readonly writeResource: SemanticRequestOperation<
    AssistantResourceWriteInput,
    void,
    AssistantLaunchErrorCode
  >;
  readonly executeResource: SemanticRequestOperation<
    AssistantResourceExecuteInput,
    AssistantResourceExecuteResult,
    AssistantLaunchErrorCode
  >;
  readonly observeSessions: SemanticEventSource<
    AssistantSessionObservationScope,
    AssistantSessionChanged
  >;
}

export const assistantLaunchService = defineSemanticService<AssistantLaunchService>(
  "shipctl.assistant-launch",
  2,
);
