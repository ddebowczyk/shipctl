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

/** Semantic provider identity. It is not an executable or command name. */
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

export type AssistantSessionMode = "standard" | "yolo";
export type AssistantIdentityState = "pending" | "ready" | "failed";

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
  readonly terminal: AssistantTerminalStartContext;
}

export interface ResumeAssistantSessionInput {
  readonly recordId: AssistantSessionId;
  readonly terminal: AssistantTerminalStartContext;
}

export interface StartedAssistantSession {
  readonly terminalId: ModuleTerminalId;
  readonly record: AssistantRecoveryRecord;
}

export interface AssistantSessionInput {
  readonly recordId: AssistantSessionId;
}

export interface RecordAssistantPlacementInput extends AssistantSessionInput {
  readonly placementProjectPath: string;
}

export interface RecordAssistantLabelInput extends AssistantSessionInput {
  readonly label: string;
}

export interface InspectAssistantModelsInput {
  readonly provider: AssistantProviderId;
}

export interface AssistantModelCatalog {
  readonly provider: AssistantProviderId;
  readonly models: readonly string[];
}

export interface AssistantProviderSettings {
  readonly defaultProvider: string | null;
  readonly defaultModel: string | null;
  readonly defaultThinkingLevel: string | null;
}

export interface AssistantProviderConfiguration {
  readonly provider: AssistantProviderId;
  readonly settings: AssistantProviderSettings;
  /** Credential namespaces only. Secret values never enter this service. */
  readonly configuredCredentialProviders: readonly string[];
}

export interface InspectAssistantProviderConfigurationInput {
  readonly provider: AssistantProviderId;
}

export interface SaveAssistantProviderConfigurationInput {
  readonly provider: AssistantProviderId;
  readonly settings: AssistantProviderSettings;
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

export type AssistantLaunchGrant = "assistant.launch" | "assistant.session-record";

export const ASSISTANT_LAUNCH_GRANTS = Object.freeze({
  launch: "assistant.launch",
  sessionRecord: "assistant.session-record",
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
  readonly refreshSessionIdentity: SemanticRequestOperation<
    AssistantSessionInput,
    AssistantRecoveryRecord | null,
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
  readonly inspectModels: SemanticRequestOperation<
    InspectAssistantModelsInput,
    AssistantModelCatalog,
    AssistantLaunchErrorCode
  >;
  readonly inspectProviderConfiguration: SemanticRequestOperation<
    InspectAssistantProviderConfigurationInput,
    AssistantProviderConfiguration,
    AssistantLaunchErrorCode
  >;
  readonly saveProviderConfiguration: SemanticRequestOperation<
    SaveAssistantProviderConfigurationInput,
    void,
    AssistantLaunchErrorCode
  >;
  readonly observeSessions: SemanticEventSource<
    AssistantSessionObservationScope,
    AssistantSessionChanged
  >;
}

export const assistantLaunchService = defineSemanticService<AssistantLaunchService>(
  "shipctl.assistant-launch",
  1,
);
