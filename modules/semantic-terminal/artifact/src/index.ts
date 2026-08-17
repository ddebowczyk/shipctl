import type * as ModuleApi from "@shipctl/module-api";

import { semanticTerminalModule } from "../../frontend/src/index.ts";

interface ArtifactHost {
  readonly pluginApi: typeof ModuleApi;
}

export function createShipctlPlugin(host: ArtifactHost): ModuleApi.ShipctlPluginDefinition {
  return host.pluginApi.defineShipctlPlugin({
    module: semanticTerminalModule,
    role: "presentation",
    requires: [
      host.pluginApi.terminalSessionsService,
      host.pluginApi.semanticTerminalsService,
    ],
  });
}
