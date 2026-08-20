import type * as ModuleApi from "@shipctl/module-api";

import {
  activateTodosRuntime,
  TODOS_MODULE_ID,
  TODOS_PLUGIN_VERSION,
  todosContributions,
} from "../../frontend/src/pluginContributions.ts";
import "../../frontend/src/todos.css";

const TODOS_RUNTIME_EFFECT_ID = "todos.runtime";
const TODOS_REQUIRED_GRANTS = ["plugin-data.read", "plugin-data.write"] as const;

interface ArtifactHost {
  readonly pluginApi: typeof ModuleApi;
}

export function createShipctlPlugin(host: ArtifactHost): ModuleApi.DirectShipctlPluginDefinition {
  return host.pluginApi.defineShipctlPlugin({
    id: TODOS_MODULE_ID,
    version: TODOS_PLUGIN_VERSION,
    role: "compound",
    requiredGrants: TODOS_REQUIRED_GRANTS,
    requires: [
      host.pluginApi.projectDocumentsService,
      host.pluginApi.projectsService,
      host.pluginApi.pluginDataService,
    ],
    backgroundEffects: [TODOS_RUNTIME_EFFECT_ID],
    async activate(context) {
      context.own(await activateTodosRuntime(context), TODOS_RUNTIME_EFFECT_ID);
      for (const configuration of todosContributions.configuration) {
        context.contributions.configuration.register(configuration);
      }
      for (const panel of todosContributions.panels) {
        context.contributions.panels.register(panel);
      }
      for (const navigation of todosContributions.projectNavigation) {
        context.contributions.projectNavigation.register(navigation);
      }
      for (const settings of todosContributions.settings) {
        context.contributions.settings.register(settings);
      }
    },
  });
}
