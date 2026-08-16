import { invoke } from "@tauri-apps/api/core";
import type {
  ModuleManagedTerminalStartContext,
  ModuleTerminalId,
} from "@shipctl/module-api";

import type {
  AssistantSessionRecord,
  PiConfig,
  PiSettings,
  RestorableAssistantProvider,
  SessionMode,
} from "./types";

interface SpawnedAssistantSession {
  readonly terminalId: ModuleTerminalId;
  readonly record: AssistantSessionRecord;
}

const ASSISTANTS_COMMAND_NAMESPACE = "plugin:shipctl-assistants|";

function assistantCommand(name: string) {
  return `${ASSISTANTS_COMMAND_NAMESPACE}${name}`;
}

export function checkCommandExists(command: string): Promise<boolean> {
  return invoke("check_command_exists", { command });
}

export function getModelsForProvider(provider: string): Promise<string[]> {
  return invoke(assistantCommand("get_models_for_provider"), { provider });
}

export function spawnAssistantSession(
  request: {
    readonly provider: RestorableAssistantProvider;
    readonly launchRepoPath: string;
    readonly placementProjectPath: string;
    readonly label: string;
    readonly sessionMode: SessionMode;
    readonly model?: string;
  },
  context: ModuleManagedTerminalStartContext,
): Promise<SpawnedAssistantSession> {
  return invoke(assistantCommand("spawn_assistant_session"), {
    request: {
      ...request,
      moduleSessionId: context.moduleSessionId,
      env: { ...context.environment },
      cols: context.columns,
      rows: context.rows,
      colorTheme: {
        ...context.colorTheme,
        palette: [...context.colorTheme.palette],
      },
    },
  });
}

export function resumeAssistantSession(
  recordId: string,
  context: ModuleManagedTerminalStartContext,
): Promise<SpawnedAssistantSession> {
  return invoke(assistantCommand("resume_assistant_session"), {
    request: {
      recordId,
      moduleSessionId: context.moduleSessionId,
      env: { ...context.environment },
      cols: context.columns,
      rows: context.rows,
      colorTheme: {
        ...context.colorTheme,
        palette: [...context.colorTheme.palette],
      },
    },
  });
}

export function tryCaptureCodexSession(recordId: string): Promise<AssistantSessionRecord | null> {
  return invoke(assistantCommand("try_capture_codex_assistant_session"), { recordId });
}

export function failSessionCapture(recordId: string): Promise<AssistantSessionRecord> {
  return invoke(assistantCommand("fail_assistant_session_capture"), { recordId });
}

export function updateSessionPlacement(recordId: string, projectPath: string): Promise<AssistantSessionRecord> {
  return invoke(assistantCommand("update_assistant_session_placement"), { recordId, placementProjectPath: projectPath });
}

export function updateSessionLabel(recordId: string, label: string): Promise<AssistantSessionRecord> {
  return invoke(assistantCommand("update_assistant_session_label"), { recordId, label });
}

export function discardSession(recordId: string): Promise<void> {
  return invoke(assistantCommand("discard_assistant_session"), { recordId });
}

export function rearmSession(recordId: string): Promise<void> {
  return invoke(assistantCommand("rearm_assistant_session"), { recordId });
}

export function listRestorableSessions(): Promise<AssistantSessionRecord[]> {
  return invoke(assistantCommand("list_restorable_assistant_sessions"));
}

export function takeStartupWarning(): Promise<string | null> {
  return invoke(assistantCommand("take_assistant_session_startup_warning"));
}

export function beginAssistantSessionPreservingShutdown(): Promise<void> {
  return invoke(assistantCommand("begin_assistant_session_preserving_shutdown"));
}

export function getPiConfig(): Promise<PiConfig> {
  return invoke(assistantCommand("get_pi_config"));
}

export function savePiSettings(settings: PiSettings): Promise<void> {
  return invoke(assistantCommand("save_pi_settings"), { settings });
}
