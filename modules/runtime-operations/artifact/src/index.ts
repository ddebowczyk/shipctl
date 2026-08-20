import type * as ModuleApi from "@shipctl/module-api";

import {
  RUNTIME_OPERATIONS_MODULE_ID,
  RUNTIME_OPERATIONS_PLUGIN_VERSION,
  RUNTIME_OPERATIONS_REQUIRED_GRANTS,
  createRuntimeOperationMessageContributions,
} from "../../frontend/src/pluginContributions.ts";

interface ArtifactHost {
  readonly pluginApi: typeof ModuleApi;
}

export function createShipctlPlugin(host: ArtifactHost): ModuleApi.DirectShipctlPluginDefinition {
  return host.pluginApi.defineShipctlPlugin({
    id: RUNTIME_OPERATIONS_MODULE_ID,
    version: RUNTIME_OPERATIONS_PLUGIN_VERSION,
    role: "headless",
    requiredGrants: RUNTIME_OPERATIONS_REQUIRED_GRANTS,
    requires: [host.pluginApi.workspaceService, host.pluginApi.configurationService],
    activate(context) {
      context.contributions.messages.register(createRuntimeOperationMessageContributions(context));
    },
  });
}
