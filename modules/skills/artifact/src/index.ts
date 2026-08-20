import type * as ModuleApi from "@shipctl/module-api";

import {
  activateSkillsRuntime,
  SKILLS_MODULE_ID,
  SKILLS_PLUGIN_VERSION,
  skillsContributions,
} from "../../frontend/src/pluginContributions.ts";

const SKILLS_RUNTIME_EFFECT_ID = "skills.runtime";

interface ArtifactHost {
  readonly pluginApi: typeof ModuleApi;
}

export function createShipctlPlugin(host: ArtifactHost): ModuleApi.DirectShipctlPluginDefinition {
  return host.pluginApi.defineShipctlPlugin({
    id: SKILLS_MODULE_ID,
    version: SKILLS_PLUGIN_VERSION,
    role: "compound",
    requires: [host.pluginApi.skillInstallationService, host.pluginApi.projectsService],
    backgroundEffects: [SKILLS_RUNTIME_EFFECT_ID],
    async activate(context) {
      context.own(await activateSkillsRuntime(context), SKILLS_RUNTIME_EFFECT_ID);
      for (const provider of skillsContributions.skillsProviders) {
        context.contributions.skillsProviders.register(provider);
      }
      for (const action of skillsContributions.projectActions) {
        context.contributions.projectActions.register(action);
      }
    },
  });
}
