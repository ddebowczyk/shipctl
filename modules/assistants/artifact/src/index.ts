import type * as ModuleApi from "@shipctl/module-api";

import { assistantsModule } from "../../frontend/src/index.ts";

interface ArtifactHost {
  readonly pluginApi: typeof ModuleApi;
}

export function createShipctlPlugin(host: ArtifactHost): ModuleApi.ShipctlPluginDefinition {
  return host.pluginApi.defineShipctlPlugin({
    module: assistantsModule,
    role: "compound",
    requires: [
      host.pluginApi.assistantLaunchService,
      host.pluginApi.credentialStoreService,
      host.pluginApi.processesService,
      host.pluginApi.terminalSessionsService,
    ],
  });
}
