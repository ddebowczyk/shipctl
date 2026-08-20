import type {
  ModuleActivationContext,
  ModuleId,
  PluginContributionFamily,
  PluginRuntimeInspection,
  ShipctlModule,
} from "@shipctl/module-api";

import {
  publishModuleRuntimeSnapshot,
  type FrontendContributionSnapshot,
  type FrontendModuleRuntimeSnapshot,
  type FrontendRuntimeSnapshot,
  type RuntimeModuleActivationPhase,
  type RuntimeModuleActivationSnapshot,
  type RuntimeSnapshotReceipt,
} from "../platform/moduleControl.ts";
import type { RuntimeModuleDescriptor } from "@shipctl/core/runtime";

export const MODULE_CONTROL_SCHEMA_VERSION = 1;

const NO_STATIC_MODULES: readonly ShipctlModule[] = Object.freeze([]);

export interface FrontendRuntimeSnapshotOptions {
  readonly registryRevision: number;
  readonly activationContextsByModule?: ReadonlyMap<ModuleId, ModuleActivationContext>;
  readonly artifactDescriptorsByModule?: ReadonlyMap<string, RuntimeModuleDescriptor>;
  /**
   * Activation-owned registrations for direct artifacts, which intentionally
   * have no legacy ShipctlModule object to serialize.
   */
  readonly inspection?: PluginRuntimeInspection;
  readonly activationOutcomes?: readonly RuntimeModuleActivationSnapshot[];
}

export type {
  FrontendContributionSnapshot,
  FrontendModuleRuntimeSnapshot,
  FrontendRuntimeSnapshot,
  RuntimeModuleActivationPhase,
  RuntimeModuleActivationSnapshot,
  RuntimeSnapshotReceipt,
};

interface OwnedContribution {
  readonly id: string;
  readonly moduleId: string;
}

/**
 * Runtime snapshots retain the established snake_case observation vocabulary;
 * this host-only projection never crosses into native artifact admission.
 */
const DIRECT_CONTRIBUTION_SNAPSHOT_KINDS: Readonly<Record<PluginContributionFamily, string>> = {
  command: "command",
  configuration: "configuration",
  "global-navigation": "global_navigation",
  "global-surface": "global_surface",
  "message-graph": "message_graph",
  panel: "panel",
  "project-action": "project_action",
  "project-facts": "project_facts_provider",
  "project-import": "project_import",
  "project-layout": "project_layout",
  "project-navigation": "project_navigation",
  "scheduled-task": "scheduled_task",
  settings: "settings",
  sidebar: "sidebar",
  "skills-provider": "skills_provider",
  "terminal-presentation": "terminal_presentation",
};

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

function messageContributions(module: ShipctlModule): FrontendContributionSnapshot[] {
  const messages = module.messages;
  return [
    ...(messages?.provides ?? []).map(({ message }) => ({ id: message.id, kind: "message_contract" })),
    ...(messages?.handles ?? []).map(({ channel }) => ({ id: channel.id, kind: "message_handler" })),
    ...(messages?.publishes ?? []).map(({ topic }) => ({ id: topic.id, kind: "message_publisher" })),
    ...(messages?.subscribes ?? []).map(({ topic }) => ({ id: topic.id, kind: "message_subscription" })),
    ...(messages?.ports ?? []).map(({ port }) => ({ id: port.id, kind: "message_port" })),
  ];
}

function terminalPresentationContributions(
  module: ShipctlModule,
): FrontendContributionSnapshot[] {
  return (module.terminalPresentations ?? []).map((contribution) => {
    if (contribution.moduleId !== module.id) {
      throw new Error(
        `Terminal presentation ${contribution.driverId} belongs to ${contribution.moduleId}, not ${module.id}`,
      );
    }
    return { id: contribution.driverId, kind: "terminal_presentation" };
  });
}

function directArtifactSnapshots(
  options: FrontendRuntimeSnapshotOptions,
  legacyModules: readonly ShipctlModule[],
): FrontendModuleRuntimeSnapshot[] {
  const descriptors = options.artifactDescriptorsByModule;
  if (descriptors === undefined) return [];
  const legacyModuleIds = new Set(legacyModules.map(({ id }) => id));
  return [...descriptors]
    .filter(([moduleId]) => !legacyModuleIds.has(moduleId))
    .map(([moduleId, descriptor]) => {
      const activation = options.activationContextsByModule?.get(moduleId as ModuleId);
      return {
        moduleId,
        artifactContentDigest: descriptor.contentDigest,
        ...(activation === undefined
          ? {}
          : { activationId: activation.identity.activationId }),
        contributions: (options.inspection?.contributions ?? [])
          .filter((contribution) => contribution.moduleId === moduleId)
          .map(({ family, id }) => ({
            id,
            kind: DIRECT_CONTRIBUTION_SNAPSHOT_KINDS[family],
          })),
      };
    });
}

export function buildFrontendRuntimeSnapshot(
  options: FrontendRuntimeSnapshotOptions,
  modules: readonly ShipctlModule[] = NO_STATIC_MODULES,
): FrontendRuntimeSnapshot {
  return {
    schemaVersion: MODULE_CONTROL_SCHEMA_VERSION,
    registryRevision: options.registryRevision,
    modules: [
      ...modules.map((module) => {
        const descriptor = options.artifactDescriptorsByModule?.get(module.id);
        const activation = options.activationContextsByModule?.get(module.id);
        return {
          moduleId: module.id,
          ...(descriptor === undefined
            ? {}
            : { artifactContentDigest: descriptor.contentDigest }),
          ...(activation === undefined
            ? {}
            : { activationId: activation.identity.activationId }),
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
            ...terminalPresentationContributions(module),
            ...messageContributions(module),
          ],
        };
      }),
      ...directArtifactSnapshots(options, modules),
    ],
    activationOutcomes: options.activationOutcomes ?? [],
  };
}

export function publishFrontendRuntimeSnapshot(
  options: FrontendRuntimeSnapshotOptions,
  modules: readonly ShipctlModule[] = NO_STATIC_MODULES,
): Promise<RuntimeSnapshotReceipt> {
  return publishModuleRuntimeSnapshot(buildFrontendRuntimeSnapshot(options, modules));
}
