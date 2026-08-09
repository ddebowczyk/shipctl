import type {
  GlobalNavigationContribution,
  GlobalSurfaceContribution,
  ModuleHostServices,
  ModuleMessages,
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
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): Promise<readonly string[]> {
  const results = await Promise.allSettled(
    moduleProjectImportContributions(modules).map((contribution) =>
      contribution.relatedPaths(projectPath, options, services)),
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

export interface ModuleTaskScheduler {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
  setInterval(callback: () => void, intervalMs: number): number;
  clearInterval(handle: number): void;
}

const BROWSER_TASK_SCHEDULER: ModuleTaskScheduler = {
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle),
  setInterval: (callback, intervalMs) => window.setInterval(callback, intervalMs),
  clearInterval: (handle) => window.clearInterval(handle),
};

function reportModuleFailure(message: string, error: unknown) {
  if (import.meta.env.DEV) console.error(message, error);
}

function activationScopedServices(services: ModuleHostServices): ModuleHostServices {
  // Message authority is already bound separately to the exact module
  // activation. A distinct facade prevents module activation from treating the
  // process-wide composition object as its own mutable singleton while keeping
  // existing host ports stable.
  return Object.freeze({ ...services });
}

function scheduleModuleTask(
  task: ModuleScheduledTask,
  services: ModuleHostServices,
  scheduler: ModuleTaskScheduler,
): () => void {
  let active = true;
  const run = () => {
    void Promise.resolve()
      .then(() => active ? task.run(services) : undefined)
      .catch((error) => reportModuleFailure(`Scheduled task ${task.id} failed:`, error));
  };

  if (task.schedule.kind === "startup") {
    run();
    return () => { active = false; };
  }

  if (task.schedule.kind === "delay") {
    if (task.schedule.delayMs < 0) {
      throw new Error(`Scheduled task ${task.id} delay must not be negative`);
    }
    const handle = scheduler.setTimeout(run, task.schedule.delayMs);
    return () => {
      active = false;
      scheduler.clearTimeout(handle);
    };
  }

  if (task.schedule.intervalMs <= 0) {
    throw new Error(`Scheduled task ${task.id} interval must be positive`);
  }
  const handle = scheduler.setInterval(run, task.schedule.intervalMs);
  return () => {
    active = false;
    scheduler.clearInterval(handle);
  };
}

export function activateModules(
  services: ModuleHostServices,
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
  scheduler: ModuleTaskScheduler = BROWSER_TASK_SCHEDULER,
): () => Promise<void> {
  return activateModulesWithMessages(services, new Map(), modules, scheduler);
}

export function activateModulesWithMessages(
  services: ModuleHostServices,
  messagesByModule: ReadonlyMap<string, ModuleMessages>,
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
  scheduler: ModuleTaskScheduler = BROWSER_TASK_SCHEDULER,
): () => Promise<void> {
  return activateModulesWithMessagesObserved(
    services,
    messagesByModule,
    modules,
    scheduler,
  ).deactivate;
}

export interface ModuleActivationFailure {
  readonly moduleId: string;
}

export interface ObservedModuleActivation {
  readonly activeModuleIds: ReadonlySet<string>;
  readonly failures: readonly ModuleActivationFailure[];
  readonly deactivate: () => Promise<void>;
}

/**
 * Activate one restart-bound composition and retain only redacted per-module
 * outcomes. The backend joins these identities with admitted registry truth;
 * arbitrary frontend exception text never crosses the IPC boundary.
 */
export function activateModulesWithMessagesObserved(
  services: ModuleHostServices,
  messagesByModule: ReadonlyMap<string, ModuleMessages>,
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
  scheduler: ModuleTaskScheduler = BROWSER_TASK_SCHEDULER,
): ObservedModuleActivation {
  const activeModuleIds = new Set<string>();
  const failures: ModuleActivationFailure[] = [];
  const activeModules = modules.flatMap((module) => {
    const scheduledTaskCancellations: Array<() => void> = [];
    const moduleServices = activationScopedServices(services);
    let deactivation: ReturnType<NonNullable<ShipctlModule["activate"]>> = undefined;
    try {
      const tasks = moduleScheduledTasks([module]);
      deactivation = module.activate?.({
        panels: moduleServices.panels,
        services: moduleServices,
        ...(messagesByModule.has(module.id)
          ? { messages: messagesByModule.get(module.id) }
          : {}),
      });
      for (const task of tasks) {
        scheduledTaskCancellations.push(scheduleModuleTask(task, moduleServices, scheduler));
      }
      activeModuleIds.add(module.id);
      return [{ deactivation, scheduledTaskCancellations }];
    } catch (error) {
      for (const cancel of [...scheduledTaskCancellations].reverse()) cancel();
      if (deactivation) {
        void Promise.resolve(deactivation.deactivate()).catch((cleanupError) =>
          reportModuleFailure(`Module ${module.id} cleanup failed:`, cleanupError));
      }
      reportModuleFailure(`Module ${module.id} activation failed:`, error);
      failures.push({ moduleId: module.id });
      return [];
    }
  });
  const deactivate = async () => {
    for (const { scheduledTaskCancellations } of [...activeModules].reverse()) {
      for (const cancel of [...scheduledTaskCancellations].reverse()) cancel();
    }
    await Promise.allSettled(
      [...activeModules].reverse().flatMap(({ deactivation }) =>
        deactivation ? [deactivation.deactivate()] : []),
    );
  };
  return { activeModuleIds, failures, deactivate };
}

/**
 * Run sequentially in registration order. Shutdown is a transaction boundary:
 * a failed module preparation must prevent native PTYs from being signalled.
 */
export async function notifyModulesBeforeShutdown(
  services: ModuleHostServices,
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): Promise<void> {
  for (const module of modules) await module.beforeShutdown?.(services);
}

async function notifyProjectLifecycle(
  callback: "onProjectOpened" | "onProjectsChanged" | "onFilesystemChanged" | "onProjectRemoved",
  value: readonly string[] | string,
  services: ModuleHostServices,
  modules: readonly ShipctlModule[] = ENABLED_MODULES,
): Promise<void> {
  await Promise.allSettled(modules.map(async (module) => {
    const handler = module.projectLifecycle?.[callback];
    if (!handler) return undefined;
    await (callback === "onProjectOpened"
      ? module.projectLifecycle?.onProjectOpened?.(value as string, services)
      : callback === "onProjectRemoved"
      ? module.projectLifecycle?.onProjectRemoved?.(value as string, services)
      : callback === "onFilesystemChanged"
        ? module.projectLifecycle?.onFilesystemChanged?.(value as readonly string[], services)
        : module.projectLifecycle?.onProjectsChanged?.(value as readonly string[], services));
  }));
}

export function notifyModulesProjectOpened(
  projectPath: string,
  services: ModuleHostServices,
  modules?: readonly ShipctlModule[],
): Promise<void> {
  return notifyProjectLifecycle("onProjectOpened", projectPath, services, modules);
}

export function notifyModulesProjectsChanged(
  projectPaths: readonly string[],
  services: ModuleHostServices,
  modules?: readonly ShipctlModule[],
): Promise<void> {
  return notifyProjectLifecycle("onProjectsChanged", projectPaths, services, modules);
}

export function notifyModulesFilesystemChanged(
  projectPaths: readonly string[],
  services: ModuleHostServices,
  modules?: readonly ShipctlModule[],
): Promise<void> {
  return notifyProjectLifecycle("onFilesystemChanged", projectPaths, services, modules);
}

export function notifyModulesProjectRemoved(
  projectPath: string,
  services: ModuleHostServices,
  modules?: readonly ShipctlModule[],
): Promise<void> {
  return notifyProjectLifecycle("onProjectRemoved", projectPath, services, modules);
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
