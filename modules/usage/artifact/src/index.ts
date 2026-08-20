import type * as ModuleApi from "@shipctl/module-api";

import {
  activateUsageRuntime,
  USAGE_MODULE_ID,
  USAGE_PLUGIN_VERSION,
  USAGE_REQUIRED_GRANTS,
  USAGE_RUNTIME_EFFECT_ID,
  usageContributions,
} from "../../frontend/src/pluginContributions.ts";
import "../../frontend/src/usage.css";

interface ArtifactHost {
  readonly pluginApi: typeof ModuleApi;
}

export function createShipctlPlugin(host: ArtifactHost): ModuleApi.DirectShipctlPluginDefinition {
  return host.pluginApi.defineShipctlPlugin({
    id: USAGE_MODULE_ID,
    version: USAGE_PLUGIN_VERSION,
    role: "compound",
    requiredGrants: USAGE_REQUIRED_GRANTS,
    requires: [
      host.pluginApi.usageSourcesService,
      host.pluginApi.pluginDataService,
      host.pluginApi.messagesService,
      host.pluginApi.schedulerService,
    ],
    backgroundEffects: [USAGE_RUNTIME_EFFECT_ID],
    async activate(context) {
      context.own(await activateUsageRuntime(context), USAGE_RUNTIME_EFFECT_ID);
      for (const surface of usageContributions.globalSurfaces) {
        context.contributions.globalSurfaces.register(surface);
      }
      for (const navigation of usageContributions.globalNavigation) {
        context.contributions.globalNavigation.register(navigation);
      }
      for (const sidebar of usageContributions.sidebars) {
        context.contributions.sidebars.register(sidebar);
      }
      for (const settings of usageContributions.settings) {
        context.contributions.settings.register(settings);
      }
      for (const task of usageContributions.scheduledTasks) {
        context.contributions.scheduledTasks.register(task);
      }
      context.contributions.messages.register(usageContributions.messages);
    },
  });
}
