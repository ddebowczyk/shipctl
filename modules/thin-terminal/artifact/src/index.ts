import type * as ModuleApi from "@shipctl/module-api";

import {
  THIN_TERMINAL_MODULE_ID,
  THIN_TERMINAL_PLUGIN_VERSION,
  THIN_TERMINAL_REQUIRED_GRANTS,
  thinTerminalContributions,
} from "../../frontend/src/pluginContributions.ts";

interface ArtifactHost {
  readonly pluginApi: typeof ModuleApi;
}

export function createShipctlPlugin(host: ArtifactHost): ModuleApi.DirectShipctlPluginDefinition {
  return host.pluginApi.defineShipctlPlugin({
    id: THIN_TERMINAL_MODULE_ID,
    version: THIN_TERMINAL_PLUGIN_VERSION,
    role: "presentation",
    requiredGrants: THIN_TERMINAL_REQUIRED_GRANTS,
    requires: [host.pluginApi.terminalSessionsService],
    activate(context) {
      for (const presentation of thinTerminalContributions.terminalPresentations) {
        context.contributions.terminalPresentations.register(presentation);
      }
    },
  });
}
