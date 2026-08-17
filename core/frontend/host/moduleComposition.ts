import type {
  GlobalNavigationContribution,
  GlobalSurfaceContribution,
  ModuleHostServices,
  ModuleActivationContext,
  ModuleId,
  ModuleScheduledTask,
  ModuleSkillsPort,
  PanelContribution,
  ProjectActionContribution,
  ProjectFactsProviderContribution,
  ProjectLayoutContribution,
  ProjectImportContribution,
  ProjectNavigationContribution,
  SidebarContribution,
  SettingsContribution,
  SettingsSlot,
  ShipctlModule,
} from "@shipctl/module-api";
import type { BuiltinGlobalSurfaceLoaders } from "./builtinGlobalSurfaceAdapters.ts";
import type { PanelMigrationAlias } from "./panelPersistence.ts";
import {
  BUILTIN_GLOBAL_NAVIGATION,
  createBuiltinGlobalSurfaceContributions,
} from "./builtinGlobalSurfaceAdapters.ts";
import { ENABLED_MODULES } from "./enabledModules.ts";
import { GlobalSurfaceRegistry } from "./globalSurfaceRegistry.ts";
import { PanelRegistry } from "./panelRegistry.ts";

export function modulePanelContributions(
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): readonly PanelContribution[] {
  return modules.flatMap((module) => module.panels ?? []);
}

export function modulePanelMigrationAliases(
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): readonly PanelMigrationAlias[] {
  return modulePanelContributions(modules).flatMap((panel) => panel.migrationAlias
    ? [{
        kind: panel.migrationAlias.kind,
        panelId: panel.id,
        label: panel.migrationAlias.label ?? panel.label,
      }]
    : []);
}

export function moduleGlobalSurfaceContributions(
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): readonly GlobalSurfaceContribution[] {
  return modules.flatMap((module) => module.globalSurfaces ?? []);
}

export function moduleGlobalNavigationContributions(
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): readonly GlobalNavigationContribution[] {
  return modules.flatMap((module) => module.globalNavigation ?? []);
}

export function moduleSidebarContributions(
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): readonly SidebarContribution[] {
  return modules
    .flatMap((module) => (module.sidebar ?? []).map((contribution) => {
      if (contribution.moduleId !== module.id) {
        throw new Error(
          `Sidebar contribution ${contribution.id} belongs to ${contribution.moduleId}, not ${module.id}`,
        );
      }
      const surface = (module.globalSurfaces ?? []).find(
        (candidate) => candidate.id === contribution.surfaceId,
      );
      if (!surface) {
        throw new Error(
          `Sidebar contribution ${contribution.id} targets missing module surface ${contribution.surfaceId}`,
        );
      }
      return contribution;
    }))
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
}

export function moduleProjectNavigationContributions(
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): readonly ProjectNavigationContribution[] {
  return modules
    .flatMap((module) => module.projectNavigation ?? [])
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
}

export function moduleProjectActionContributions(
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): readonly ProjectActionContribution[] {
  return modules
    .flatMap((module) => module.projectActions ?? [])
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
}

export function enabledProjectActionContributions(
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): readonly ProjectActionContribution[] {
  return moduleProjectActionContributions(modules);
}

export function moduleProjectLayoutContributions(
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): readonly ProjectLayoutContribution[] {
  return modules
    .flatMap((module) => module.projectLayout ?? [])
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
}

export function enabledProjectLayoutContributions(
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): readonly ProjectLayoutContribution[] {
  return moduleProjectLayoutContributions(modules);
}

export function moduleProjectImportContributions(
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): readonly ProjectImportContribution[] {
  return modules.flatMap((module) => module.projectImport ? [module.projectImport] : []);
}

export async function discoverRelatedProjectPaths(
  projectPath: string,
  options: { readonly expandRelated: boolean },
  services: ModuleHostServices,
  moduleActivations: ReadonlyMap<ModuleId, ModuleActivationContext>,
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): Promise<readonly string[]> {
  const results = await Promise.allSettled(
    moduleProjectImportContributions(modules).map(async (contribution) => {
      const activation = moduleActivations.get(contribution.moduleId);
      if (!activation || activation.disposed) {
        throw new Error(`Module ${contribution.moduleId} is not active`);
      }
      return contribution.relatedPaths(projectPath, options, services, activation);
    }),
  );
  return [...new Set(results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []))];
}

export function moduleProjectFactsProviders(
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): readonly ProjectFactsProviderContribution[] {
  return modules.flatMap((module) => {
    const provider = module.projectFactsProvider;
    if (!provider) return [];
    if (provider.moduleId !== module.id) {
      throw new Error(
        `Project facts provider ${provider.id} belongs to ${provider.moduleId}, not ${module.id}`,
      );
    }
    return [provider];
  });
}

export function selectProjectFactsProvider(
  providers: readonly ProjectFactsProviderContribution[],
): ProjectFactsProviderContribution | null {
  if (providers.length > 1) {
    throw new Error("Only one enabled provider may supply project facts");
  }
  return providers[0] ?? null;
}

export function enabledProjectFactsProvider(
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): ProjectFactsProviderContribution | null {
  return selectProjectFactsProvider(moduleProjectFactsProviders(modules));
}

export function moduleSkillsProvider(
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): ModuleSkillsPort | null {
  const providers = modules.flatMap((module) => {
    const provider = module.skillsProvider;
    if (!provider) return [];
    if (provider.moduleId !== module.id) {
      throw new Error(
        `Skills provider ${provider.id} belongs to ${provider.moduleId}, not ${module.id}`,
      );
    }
    return [provider.port];
  });
  if (providers.length > 1) {
    throw new Error("Only one enabled module may provide the Skills service");
  }
  return providers[0] ?? null;
}

export function moduleSettingsContributions(
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
  slot?: SettingsSlot,
): readonly SettingsContribution[] {
  return modules
    .flatMap((module) => module.settings ?? [])
    .filter((contribution) => slot === undefined
      || (contribution.slot ?? "projects.after") === slot)
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
}

export function moduleScheduledTasks(
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): readonly ModuleScheduledTask[] {
  return modules.flatMap((module) => (module.scheduledTasks ?? []).map((task) => {
    if (task.moduleId !== module.id) {
      throw new Error(
        `Scheduled task ${task.id} belongs to ${task.moduleId}, not ${module.id}`,
      );
    }
    return task;
  }));
}

/**
 * Run sequentially in registration order. Shutdown is a transaction boundary:
 * a failed module preparation must prevent native PTYs from being signalled.
 */
export async function notifyModulesBeforeShutdown(
  services: ModuleHostServices,
  activations: ReadonlyMap<ModuleId, ModuleActivationContext>,
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): Promise<void> {
  for (const module of modules) {
    const activation = activations.get(module.id);
    if (!module.beforeShutdown || !activation || activation.disposed) continue;
    await module.beforeShutdown(services, activation);
  }
}

async function notifyProjectLifecycle(
  callback: "onProjectOpened" | "onProjectsChanged" | "onFilesystemChanged" | "onProjectRemoved",
  value: readonly string[] | string,
  services: ModuleHostServices,
  activations: ReadonlyMap<ModuleId, ModuleActivationContext>,
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): Promise<void> {
  await Promise.allSettled(modules.map(async (module) => {
    const handler = module.projectLifecycle?.[callback];
    const activation = activations.get(module.id);
    if (!handler || !activation || activation.disposed) return undefined;
    await (callback === "onProjectOpened"
      ? module.projectLifecycle?.onProjectOpened?.(value as string, services, activation)
      : callback === "onProjectRemoved"
      ? module.projectLifecycle?.onProjectRemoved?.(value as string, services, activation)
      : callback === "onFilesystemChanged"
        ? module.projectLifecycle?.onFilesystemChanged?.(value as readonly string[], services, activation)
        : module.projectLifecycle?.onProjectsChanged?.(value as readonly string[], services, activation));
  }));
}

export function notifyModulesProjectOpened(
  projectPath: string,
  services: ModuleHostServices,
  activations: ReadonlyMap<ModuleId, ModuleActivationContext>,
  modules?: readonly ShipctlModule[],
): Promise<void> {
  return notifyProjectLifecycle("onProjectOpened", projectPath, services, activations, modules);
}

export function notifyModulesProjectsChanged(
  projectPaths: readonly string[],
  services: ModuleHostServices,
  activations: ReadonlyMap<ModuleId, ModuleActivationContext>,
  modules?: readonly ShipctlModule[],
): Promise<void> {
  return notifyProjectLifecycle("onProjectsChanged", projectPaths, services, activations, modules);
}

export function notifyModulesFilesystemChanged(
  projectPaths: readonly string[],
  services: ModuleHostServices,
  activations: ReadonlyMap<ModuleId, ModuleActivationContext>,
  modules?: readonly ShipctlModule[],
): Promise<void> {
  return notifyProjectLifecycle("onFilesystemChanged", projectPaths, services, activations, modules);
}

export function notifyModulesProjectRemoved(
  projectPath: string,
  services: ModuleHostServices,
  activations: ReadonlyMap<ModuleId, ModuleActivationContext>,
  modules?: readonly ShipctlModule[],
): Promise<void> {
  return notifyProjectLifecycle("onProjectRemoved", projectPath, services, activations, modules);
}

export function createEnabledPanelRegistry(
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): PanelRegistry {
  return PanelRegistry.create(modulePanelContributions(modules));
}

export function createEnabledGlobalSurfaceRegistry(
  builtinLoaders: BuiltinGlobalSurfaceLoaders,
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): GlobalSurfaceRegistry {
  return GlobalSurfaceRegistry.create({
    surfaces: [
      ...createBuiltinGlobalSurfaceContributions(builtinLoaders),
      ...moduleGlobalSurfaceContributions(modules),
    ],
    navigation: [
      ...BUILTIN_GLOBAL_NAVIGATION,
      ...moduleGlobalNavigationContributions(modules),
    ],
  });
}
