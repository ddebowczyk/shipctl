import type * as ModuleApi from "@shipctl/module-api";

import {
  activateGitRuntime,
  gitContributions,
  GIT_MODULE_ID,
  GIT_PLUGIN_VERSION,
} from "../../frontend/src/pluginContributions.ts";
import "../../frontend/src/git.css";

const GIT_RUNTIME_EFFECT_ID = "git.runtime";
const GIT_REQUIRED_GRANTS = ["plugin-data.read", "plugin-data.write"] as const;

interface ArtifactHost {
  readonly pluginApi: typeof ModuleApi;
}

export function createShipctlPlugin(host: ArtifactHost): ModuleApi.DirectShipctlPluginDefinition {
  return host.pluginApi.defineShipctlPlugin({
    id: GIT_MODULE_ID,
    version: GIT_PLUGIN_VERSION,
    role: "compound",
    requiredGrants: GIT_REQUIRED_GRANTS,
    requires: [
      host.pluginApi.gitService,
      host.pluginApi.projectsService,
      host.pluginApi.pluginDataService,
    ],
    backgroundEffects: [GIT_RUNTIME_EFFECT_ID],
    async activate(context) {
      context.own(await activateGitRuntime(context), GIT_RUNTIME_EFFECT_ID);
      for (const configuration of gitContributions.configuration) {
        context.contributions.configuration.register(configuration);
      }
      for (const panel of gitContributions.panels) {
        context.contributions.panels.register(panel);
      }
      for (const navigation of gitContributions.projectNavigation) {
        context.contributions.projectNavigation.register(navigation);
      }
      for (const layout of gitContributions.projectLayout) {
        context.contributions.projectLayouts.register(layout);
      }
      for (const action of gitContributions.projectActions) {
        context.contributions.projectActions.register(action);
      }
      for (const facts of gitContributions.projectFacts) {
        context.contributions.projectFacts.register(facts);
      }
      for (const projectImport of gitContributions.projectImports) {
        context.contributions.projectImports.register(projectImport);
      }
      for (const settings of gitContributions.settings) {
        context.contributions.settings.register(settings);
      }
    },
  });
}
