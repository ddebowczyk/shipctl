import type { ShipctlModule } from "@shipctl/module-api";

import { beginAssistantSessionPreservingShutdown } from "./client";
import { activateAssistantRuntime, restoreAssistantSessions } from "./runtime";

export const ASSISTANT_LAUNCHER_PANEL_ID = "assistants.launcher" as const;

export const assistantsModule = {
  id: "shipctl.assistants",
  version: "0.0.0",
  panels: [
    {
      id: ASSISTANT_LAUNCHER_PANEL_ID,
      moduleId: "shipctl.assistants",
      scope: "project",
      label: "New Agent",
      icon: { name: "square-terminal", label: "Agent" },
      singleton: "per-project",
      order: 30,
      shortcut: "⇧⌘T",
      menuEvent: "new_session",
      newSession: { label: "Agent", order: 10 },
      unavailable: {
        title: "Agent launcher unavailable",
        description: "The Assistant providers module could not be loaded.",
      },
      migrationAlias: { kind: "launcher", label: "New Agent" },
      load: () => import("./SessionLauncher"),
    },
  ],
  projectLifecycle: {
    onProjectsChanged: restoreAssistantSessions,
  },
  beforeShutdown: beginAssistantSessionPreservingShutdown,
  activate: ({ services }) => {
    const deactivate = activateAssistantRuntime(services);
    return { deactivate };
  },
} as const satisfies ShipctlModule;

export { launchAssistant, restoreAssistantSessions } from "./runtime";
export { CODING_ASSISTANTS } from "./catalog";
export type {
  AssistantCaptureState,
  AssistantOwnerMetadata,
  AssistantSessionRecord,
  CodingAssistant,
  RestorableAssistantProvider,
  SessionMode,
} from "./types";
