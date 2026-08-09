export type SessionMode = "standard" | "yolo";
export type RestorableAssistantProvider = "claude" | "codex";
export type AssistantCaptureState = "pending" | "ready" | "failed";

export interface CodingAssistant {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly docsUrl?: string;
  readonly command: string;
  readonly yoloFlag: string | null;
  readonly modelFlag: string;
}

export interface AssistantSessionRecord extends Readonly<Record<string, ModuleJsonValue>> {
  readonly recordId: string;
  readonly provider: RestorableAssistantProvider;
  readonly providerSessionId: string | null;
  readonly launchRepoPath: string;
  readonly placementProjectPath: string;
  readonly label: string;
  readonly sessionMode: SessionMode;
  readonly model: string | null;
  readonly captureState: AssistantCaptureState;
  readonly restoreOnNextLaunch: boolean;
  readonly startedAt: number;
  readonly updatedAt: number;
}

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
  readonly mode: SessionMode;
  readonly record: AssistantSessionRecord | null;
  readonly restoring: boolean;
}
import type { ModuleJsonValue } from "@shipctl/module-api";
