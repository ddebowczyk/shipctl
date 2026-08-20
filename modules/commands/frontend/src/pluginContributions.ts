import type {
  CommandContribution,
  ModuleActivationContext,
  PanelContribution,
  ProjectNavigationContribution,
} from "@shipctl/module-api";

import {
  commandsDataClientFor,
  configureCommandsDataClient,
} from "./commandsDataClient";

export const COMMANDS_MODULE_ID = "shipctl.commands" as const;
export const COMMANDS_PLUGIN_VERSION = "0.0.0" as const;
export const COMMANDS_PANEL_ID = "core.commands" as const;

/**
 * Presentation declarations are ordinary values until the artifact activates.
 * The direct plugin entry owns their registration leases through its activation
 * context; this module deliberately has no `ShipctlModule` compatibility shape.
 */
export const commandsContributions = Object.freeze({
  commands: Object.freeze([
    {
      id: "commands.open-panel",
      moduleId: COMMANDS_MODULE_ID,
      label: "New Commands Panel",
      isEnabled: ({ activeProjectId }) => activeProjectId !== null,
      run: ({ openPanel }) => openPanel(COMMANDS_PANEL_ID),
    },
  ] satisfies readonly CommandContribution[]),
  panels: Object.freeze([
    {
      id: COMMANDS_PANEL_ID,
      moduleId: COMMANDS_MODULE_ID,
      scope: "project",
      label: "Commands",
      icon: { name: "list", label: "Commands" },
      shortcut: "⇧⌘C",
      singleton: "per-project",
      order: 20,
      unavailable: {
        title: "Commands panel unavailable",
        description: "The project command runner module could not be loaded.",
      },
      migrationAlias: { kind: "commands", label: "Commands" },
      load: () => import("./CommandsPanel"),
    },
  ] satisfies readonly PanelContribution[]),
  projectNavigation: Object.freeze([
    {
      id: "commands.project-navigation",
      moduleId: COMMANDS_MODULE_ID,
      panelId: COMMANDS_PANEL_ID,
      order: 20,
      load: () => import("./CommandsProjectRow"),
    },
  ] satisfies readonly ProjectNavigationContribution[]),
});

/** Configure the activation-scoped persistence client and return its cleanup. */
export function activateCommandsRuntime(
  activation: ModuleActivationContext,
): () => void {
  configureCommandsDataClient(commandsDataClientFor(activation));
  return () => configureCommandsDataClient(null);
}
