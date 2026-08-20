import {
  ASSISTANT_LAUNCH_GRANTS,
  TERMINAL_SESSION_GRANTS,
  type PanelContribution,
} from "@shipctl/module-api";

export const ASSISTANTS_MODULE_ID = "shipctl.assistants" as const;
export const ASSISTANTS_PLUGIN_VERSION = "0.0.0" as const;
export const ASSISTANT_LAUNCHER_PANEL_ID = "assistants.launcher" as const;

export const ASSISTANTS_REQUIRED_GRANTS = [
  ASSISTANT_LAUNCH_GRANTS.launch,
  ASSISTANT_LAUNCH_GRANTS.sessionRecord,
  ASSISTANT_LAUNCH_GRANTS.resourceRead,
  ASSISTANT_LAUNCH_GRANTS.resourceWrite,
  ASSISTANT_LAUNCH_GRANTS.resourceExecute,
  "credential.inspect",
  "credential.write",
  TERMINAL_SESSION_GRANTS.start,
  TERMINAL_SESSION_GRANTS.attach,
] as const;

/**
 * Inert presentation declarations. The direct artifact owns their registry
 * leases through its activation context instead of exporting a static module.
 */
export const assistantsContributions = Object.freeze({
  panels: Object.freeze([
    {
      id: ASSISTANT_LAUNCHER_PANEL_ID,
      moduleId: ASSISTANTS_MODULE_ID,
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
  ] satisfies readonly PanelContribution[]),
});
