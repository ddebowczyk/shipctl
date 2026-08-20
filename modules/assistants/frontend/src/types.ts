import type {
  AssistantIdentityState,
  AssistantRecoveryRecord,
  ModuleJsonValue,
} from "@shipctl/module-api";

/** Presentation choices owned by this artifact, not a host-side provider enum. */
export type SessionMode = "standard" | "yolo";
export type RestorableAssistantProvider = string;
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

/** Pi's on-disk settings shape is plugin policy. */
export interface PiSettings {
  readonly defaultProvider: string | null;
  readonly defaultModel: string | null;
  readonly defaultThinkingLevel: string | null;
}

export interface PiConfig {
  readonly settings: PiSettings;
  readonly configuredProviders: readonly string[];
}

export interface AssistantOwnerMetadata extends Readonly<Record<string, ModuleJsonValue>> {
  readonly provider: string;
  /** A persisted recovery record may come from an external policy. */
  readonly mode: string;
  readonly record: AssistantSessionRecord | null;
  readonly restoring: boolean;
}
