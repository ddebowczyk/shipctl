import type {
  ModuleHostServices,
  PanelContribution,
  ProjectNavigationContribution,
  SettingsContribution,
  ShepModule,
} from "@shep/module-api";

import type { BuiltinPanelLoaders } from "./builtinPanelAdapters";
import { createBuiltinPanelContributions } from "./builtinPanelAdapters";
import { ENABLED_MODULES } from "./enabledModules";
import { PanelRegistry } from "./panelRegistry";

export function modulePanelContributions(
  modules: readonly ShepModule[],
): readonly PanelContribution[] {
  return modules.flatMap((module) => module.panels ?? []);
}

export function moduleProjectNavigationContributions(
  modules: readonly ShepModule[] = ENABLED_MODULES,
): readonly ProjectNavigationContribution[] {
  return modules
    .flatMap((module) => module.projectNavigation ?? [])
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
}

export function moduleSettingsContributions(
  modules: readonly ShepModule[] = ENABLED_MODULES,
): readonly SettingsContribution[] {
  return modules
    .flatMap((module) => module.settings ?? [])
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
}

async function notifyProjectLifecycle(
  callback: "onProjectsChanged" | "onFilesystemChanged" | "onProjectRemoved",
  value: readonly string[] | string,
  services: ModuleHostServices,
  modules: readonly ShepModule[] = ENABLED_MODULES,
): Promise<void> {
  await Promise.allSettled(modules.map(async (module) => {
    const handler = module.projectLifecycle?.[callback];
    if (!handler) return undefined;
    await (callback === "onProjectRemoved"
      ? module.projectLifecycle?.onProjectRemoved?.(value as string, services)
      : callback === "onFilesystemChanged"
        ? module.projectLifecycle?.onFilesystemChanged?.(value as readonly string[], services)
        : module.projectLifecycle?.onProjectsChanged?.(value as readonly string[], services));
  }));
}

export function notifyModulesProjectsChanged(
  projectPaths: readonly string[],
  services: ModuleHostServices,
  modules?: readonly ShepModule[],
): Promise<void> {
  return notifyProjectLifecycle("onProjectsChanged", projectPaths, services, modules);
}

export function notifyModulesFilesystemChanged(
  projectPaths: readonly string[],
  services: ModuleHostServices,
  modules?: readonly ShepModule[],
): Promise<void> {
  return notifyProjectLifecycle("onFilesystemChanged", projectPaths, services, modules);
}

export function notifyModulesProjectRemoved(
  projectPath: string,
  services: ModuleHostServices,
  modules?: readonly ShepModule[],
): Promise<void> {
  return notifyProjectLifecycle("onProjectRemoved", projectPath, services, modules);
}

export function createEnabledPanelRegistry(
  builtinLoaders: BuiltinPanelLoaders,
  modules: readonly ShepModule[] = ENABLED_MODULES,
): PanelRegistry {
  return PanelRegistry.create([
    ...createBuiltinPanelContributions(builtinLoaders),
    ...modulePanelContributions(modules),
  ]);
}
