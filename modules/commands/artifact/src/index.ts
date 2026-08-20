import type * as ModuleApi from "@shipctl/module-api";

import {
  activateCommandsRuntime,
  COMMANDS_MODULE_ID,
  COMMANDS_PLUGIN_VERSION,
  commandsContributions,
} from "../../frontend/src/pluginContributions.ts";
import "../../frontend/src/commands.css";

const COMMANDS_RUNTIME_EFFECT_ID = "commands.runtime";
const COMMANDS_REQUIRED_GRANTS = ["plugin-data.read", "plugin-data.write"] as const;

interface ArtifactHost {
  readonly pluginApi: typeof ModuleApi;
}

export function createShipctlPlugin(host: ArtifactHost): ModuleApi.DirectShipctlPluginDefinition {
  return host.pluginApi.defineShipctlPlugin({
    id: COMMANDS_MODULE_ID,
    version: COMMANDS_PLUGIN_VERSION,
    role: "compound",
    requiredGrants: COMMANDS_REQUIRED_GRANTS,
    requires: [host.pluginApi.pluginDataService],
    backgroundEffects: [COMMANDS_RUNTIME_EFFECT_ID],
    activate(context) {
      context.own(activateCommandsRuntime(context), COMMANDS_RUNTIME_EFFECT_ID);
      for (const command of commandsContributions.commands) {
        context.contributions.commands.register(command);
      }
      for (const panel of commandsContributions.panels) {
        context.contributions.panels.register(panel);
      }
      for (const navigation of commandsContributions.projectNavigation) {
        context.contributions.projectNavigation.register(navigation);
      }
    },
  });
}
