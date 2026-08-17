import type * as ModuleApi from "@shipctl/module-api";

import { thinTerminalModule } from "../../frontend/src/index.ts";

interface ArtifactHost {
  readonly pluginApi: typeof ModuleApi;
}

export function createShipctlPlugin(host: ArtifactHost): ModuleApi.ShipctlPluginDefinition {
  return host.pluginApi.defineShipctlPlugin({
    module: thinTerminalModule,
    role: "presentation",
    requires: [host.pluginApi.terminalSessionsService],
  });
}
