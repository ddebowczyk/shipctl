import { invoke } from "@tauri-apps/api/core";
import type { ShipctlModule } from "@shipctl/module-api";

import { ENABLED_MODULES } from "./enabledModules.ts";

export const MODULE_CONTROL_SCHEMA_VERSION = 1;

export interface FrontendContributionSnapshot {
  readonly id: string;
  readonly kind: string;
}

export interface FrontendModuleRuntimeSnapshot {
  readonly moduleId: string;
  readonly contributions: readonly FrontendContributionSnapshot[];
}

export interface FrontendRuntimeSnapshot {
  readonly schemaVersion: number;
  readonly modules: readonly FrontendModuleRuntimeSnapshot[];
}

export interface RuntimeSnapshotReceipt {
  readonly schemaVersion: number;
  readonly instanceId: string;
  readonly registryRevision: number;
  readonly publishedAtUnixMs: number;
  readonly moduleCount: number;
  readonly contributionCount: number;
}

interface OwnedContribution {
  readonly id: string;
  readonly moduleId: string;
}

function owned(
  module: ShipctlModule,
  kind: string,
  contributions: readonly OwnedContribution[] | undefined,
): FrontendContributionSnapshot[] {
  return (contributions ?? []).map((contribution) => {
    if (contribution.moduleId !== module.id) {
      throw new Error(
        `Contribution ${contribution.id} belongs to ${contribution.moduleId}, not ${module.id}`,
      );
    }
    return { id: contribution.id, kind };
  });
}

export function buildFrontendRuntimeSnapshot(
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): FrontendRuntimeSnapshot {
  return {
    schemaVersion: MODULE_CONTROL_SCHEMA_VERSION,
    modules: modules.map((module) => ({
      moduleId: module.id,
      contributions: [
        ...owned(module, "panel", module.panels),
        ...owned(module, "global_surface", module.globalSurfaces),
        ...owned(module, "global_navigation", module.globalNavigation),
        ...owned(module, "sidebar", module.sidebar),
        ...owned(module, "project_navigation", module.projectNavigation),
        ...owned(module, "project_layout", module.projectLayout),
        ...owned(module, "project_action", module.projectActions),
        ...owned(
          module,
          "project_facts_provider",
          module.projectFactsProvider ? [module.projectFactsProvider] : [],
        ),
        ...owned(
          module,
          "project_import",
          module.projectImport ? [module.projectImport] : [],
        ),
        ...owned(module, "settings", module.settings),
        ...owned(
          module,
          "skills_provider",
          module.skillsProvider ? [module.skillsProvider] : [],
        ),
        ...owned(module, "scheduled_task", module.scheduledTasks),
      ],
    })),
  };
}

export function publishFrontendRuntimeSnapshot(
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): Promise<RuntimeSnapshotReceipt> {
  return invoke("publish_module_runtime_snapshot", {
    snapshot: buildFrontendRuntimeSnapshot(modules),
  });
}
