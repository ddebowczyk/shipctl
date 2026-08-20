import type * as ModuleApi from "@shipctl/module-api";

import {
  PORTS_MODULE_ID,
  PORTS_PLUGIN_VERSION,
  portsContributions,
} from "../../frontend/src/pluginContributions.ts";

interface ArtifactHost {
  readonly pluginApi: typeof ModuleApi;
}

export function createShipctlPlugin(host: ArtifactHost): ModuleApi.DirectShipctlPluginDefinition {
  return host.pluginApi.defineShipctlPlugin({
    id: PORTS_MODULE_ID,
    version: PORTS_PLUGIN_VERSION,
    role: "presentation",
    requires: [host.pluginApi.processesService],
    activate(context) {
      for (const surface of portsContributions.globalSurfaces) {
        context.contributions.globalSurfaces.register(surface);
      }
      for (const navigation of portsContributions.globalNavigation) {
        context.contributions.globalNavigation.register(navigation);
      }
    },
  });
}
