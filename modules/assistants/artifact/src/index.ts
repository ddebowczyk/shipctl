import type * as ModuleApi from "@shipctl/module-api";

import { assistantLaunchClientFor } from "../../frontend/src/assistantLaunchClient.ts";
import {
  ASSISTANTS_MODULE_ID,
  ASSISTANTS_PLUGIN_VERSION,
  ASSISTANTS_REQUIRED_GRANTS,
  assistantsContributions,
} from "../../frontend/src/pluginContributions.ts";
import { createAssistantProviderPolicyCatalog } from "../../frontend/src/assistantProviderPolicy.ts";
import {
  activateAssistantsRuntime,
  prepareAssistantsForShutdown,
} from "../../frontend/src/runtime.ts";

const ASSISTANTS_RUNTIME_EFFECT_ID = "assistants.runtime";

interface ArtifactHost {
  readonly pluginApi: typeof ModuleApi;
}

export function createShipctlPlugin(host: ArtifactHost): ModuleApi.DirectShipctlPluginDefinition {
  // Fail artifact activation before it receives any native authority when the
  // trusted provider/capture declarations are internally inconsistent.
  createAssistantProviderPolicyCatalog();
  return host.pluginApi.defineShipctlPlugin({
    id: ASSISTANTS_MODULE_ID,
    version: ASSISTANTS_PLUGIN_VERSION,
    role: "compound",
    requiredGrants: ASSISTANTS_REQUIRED_GRANTS,
    requires: [
      host.pluginApi.assistantLaunchService,
      host.pluginApi.credentialStoreService,
      host.pluginApi.processesService,
      host.pluginApi.terminalSessionsService,
      host.pluginApi.projectsService,
    ],
    backgroundEffects: [ASSISTANTS_RUNTIME_EFFECT_ID],
    async activate(context) {
      context.own(
        await activateAssistantsRuntime(context, assistantLaunchClientFor(context)),
        ASSISTANTS_RUNTIME_EFFECT_ID,
      );
      for (const panel of assistantsContributions.panels) {
        context.contributions.panels.register(panel);
      }
    },
    beforeShutdown(context) {
      return prepareAssistantsForShutdown(context, assistantLaunchClientFor(context));
    },
  });
}
