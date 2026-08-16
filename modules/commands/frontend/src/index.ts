import type { ShipctlModule } from "@shipctl/module-api";

import { loadProjectCommands } from "./runtime";
import { useCommandsStore } from "./store";
import {
  activeCommandsDataClient,
  commandsDataClientFor,
  configureCommandsDataClient,
} from "./commandsDataClient";
import "./commands.css";

export const COMMANDS_PANEL_ID = "core.commands" as const;

export const commandsModule = {
  id: "shipctl.commands",
  version: "0.0.0",
  commands: [
    {
      id: "commands.open-panel",
      moduleId: "shipctl.commands",
      label: "New Commands Panel",
      isEnabled: ({ activeProjectId }) => activeProjectId !== null,
      run: ({ openPanel }) => openPanel(COMMANDS_PANEL_ID),
    },
  ],
  panels: [
    {
      id: COMMANDS_PANEL_ID,
      moduleId: "shipctl.commands",
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
  ],
  projectNavigation: [
    {
      id: "commands.project-navigation",
      moduleId: "shipctl.commands",
      panelId: COMMANDS_PANEL_ID,
      order: 20,
      load: () => import("./CommandsProjectRow"),
    },
  ],
  projectLifecycle: {
    onProjectOpened: loadProjectCommands,
    onProjectRemoved: (projectPath) => {
      // The active module client owns only revision metadata for this project.
      // Removing the project invalidates that metadata with the module state.
      activeCommandsDataClient().forget(projectPath);
      useCommandsStore.getState().removeProject(projectPath);
    },
  },
  activate({ activation }) {
    configureCommandsDataClient(commandsDataClientFor(activation));
    return {
      deactivate() {
        configureCommandsDataClient(null);
      },
    };
  },
} as const satisfies ShipctlModule;

export { generateCommandName } from "./CommandsPanel";
export {
  createCommand,
  deleteCommand,
  loadProjectCommands,
  resolveCommandCwd,
  startAllCommands,
  startCommand,
  stopAllCommands,
  stopCommand,
  updateCommand,
} from "./runtime";
export { useCommandsStore } from "./store";
export type { CommandConfig, CommandState, CommandStatus } from "./types";
