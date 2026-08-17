import type * as ModuleApi from "@shipctl/module-api";

import { gitModule } from "../../frontend/src/index.ts";

interface ArtifactHost {
  readonly pluginApi: typeof ModuleApi;
}

export function createShipctlPlugin(host: ArtifactHost): ModuleApi.ShipctlPluginDefinition {
  return host.pluginApi.defineShipctlPlugin({
    module: gitModule,
    role: "compound",
    requires: [host.pluginApi.gitService],
  });
}
