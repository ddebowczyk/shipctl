import type * as ModuleApi from "@shipctl/module-api";

import { usageModule } from "../../frontend/src/index.ts";

interface ArtifactHost {
  readonly pluginApi: typeof ModuleApi;
}

export function createShipctlPlugin(host: ArtifactHost): ModuleApi.ShipctlPluginDefinition {
  return host.pluginApi.defineShipctlPlugin({
    module: usageModule,
    role: "compound",
    requires: [
      host.pluginApi.usageSourcesService,
      host.pluginApi.pluginDataService,
      host.pluginApi.messagesService,
      host.pluginApi.schedulerService,
    ],
  });
}
