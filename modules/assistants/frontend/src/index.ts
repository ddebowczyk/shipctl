import {
  ASSISTANT_LAUNCH_GRANTS,
  TERMINAL_SESSION_GRANTS,
  type ShipctlModule,
} from "@shipctl/module-api";

import { assistantLaunchClientFor } from "./assistantLaunchClient";
import { activateAssistantRuntime, restoreAssistantSessions } from "./runtime";

export const ASSISTANT_LAUNCHER_PANEL_ID = "assistants.launcher" as const;

export const assistantsModule = {
  id: "shipctl.assistants",
  version: "0.0.0",
  requiredGrants: [
    ASSISTANT_LAUNCH_GRANTS.launch,
    ASSISTANT_LAUNCH_GRANTS.sessionRecord,
    "credential.inspect",
    "credential.write",
    TERMINAL_SESSION_GRANTS.start,
    TERMINAL_SESSION_GRANTS.attach,
  ],
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
    onProjectsChanged: (projectPaths, services, activation) => (
      restoreAssistantSessions(projectPaths, services, assistantLaunchClientFor(activation))
    ),
  },
  beforeShutdown: (_services, activation) => (
    assistantLaunchClientFor(activation).beginAssistantSessionPreservingShutdown()
  ),
  activate: ({ services, activation }) => {
    const deactivate = activateAssistantRuntime(services, assistantLaunchClientFor(activation));
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
