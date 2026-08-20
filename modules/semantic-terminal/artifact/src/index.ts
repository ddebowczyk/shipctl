import type * as ModuleApi from "@shipctl/module-api";

import {
  SEMANTIC_TERMINAL_MODULE_ID,
  SEMANTIC_TERMINAL_PLUGIN_VERSION,
  SEMANTIC_TERMINAL_REQUIRED_GRANTS,
  semanticTerminalContributions,
} from "../../frontend/src/pluginContributions.ts";

interface ArtifactHost {
  readonly pluginApi: typeof ModuleApi;
}

export function createShipctlPlugin(host: ArtifactHost): ModuleApi.DirectShipctlPluginDefinition {
  return host.pluginApi.defineShipctlPlugin({
    id: SEMANTIC_TERMINAL_MODULE_ID,
    version: SEMANTIC_TERMINAL_PLUGIN_VERSION,
    role: "presentation",
    requiredGrants: SEMANTIC_TERMINAL_REQUIRED_GRANTS,
    requires: [
      host.pluginApi.terminalSessionsService,
      host.pluginApi.semanticTerminalsService,
    ],
    activate(context) {
      for (const presentation of semanticTerminalContributions.terminalPresentations) {
        context.contributions.terminalPresentations.register(presentation);
      }
    },
  });
}
