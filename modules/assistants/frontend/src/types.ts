import type {
  AssistantIdentityState,
  AssistantProviderSettings,
  AssistantRecoveryRecord,
  AssistantSessionMode,
  ModuleJsonValue,
} from "@shipctl/module-api";

export type SessionMode = AssistantSessionMode;
export type RestorableAssistantProvider = "claude" | "codex";
export type AssistantCaptureState = AssistantIdentityState;

export interface CodingAssistant {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly docsUrl?: string;
  readonly command: string;
  readonly yoloFlag: string | null;
  readonly modelFlag: string;
}

export type AssistantSessionRecord = AssistantRecoveryRecord;

export type PiSettings = AssistantProviderSettings;

export interface PiConfig {
  readonly settings: PiSettings;
  readonly configuredProviders: readonly string[];
}

export interface AssistantOwnerMetadata extends Readonly<Record<string, ModuleJsonValue>> {
  readonly provider: string;
  readonly mode: SessionMode;
  readonly record: AssistantSessionRecord | null;
  readonly restoring: boolean;
}
