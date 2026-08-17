import type * as ModuleApi from "@shipctl/module-api";

import { skillsModule } from "../../frontend/src/index.ts";

interface ArtifactHost {
  readonly pluginApi: typeof ModuleApi;
}

export function createShipctlPlugin(host: ArtifactHost): ModuleApi.ShipctlPluginDefinition {
  return host.pluginApi.defineShipctlPlugin({
    module: skillsModule,
    role: "compound",
    requires: [host.pluginApi.skillInstallationService],
  });
}
