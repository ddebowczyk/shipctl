import type {
  GlobalNavigationContribution,
  GlobalSurfaceContribution,
  ModuleHostServices,
  ModuleSkillsPort,
  PanelContribution,
  ProjectActionContribution,
  ProjectFactsProviderContribution,
  ProjectLayoutContribution,
  ProjectNavigationContribution,
  SettingsContribution,
  ShepModule,
} from "@shep/module-api";

import type { BuiltinGlobalSurfaceLoaders } from "./builtinGlobalSurfaceAdapters";
import type { BuiltinPanelLoaders } from "./builtinPanelAdapters";
import type { LegacyPanelDefinition } from "./panelPersistence";
import { createBuiltinPanelContributions } from "./builtinPanelAdapters";
import {
  BUILTIN_GLOBAL_NAVIGATION,
  createBuiltinGlobalSurfaceContributions,
} from "./builtinGlobalSurfaceAdapters";
import { ENABLED_MODULES } from "./enabledModules";
import { GlobalSurfaceRegistry } from "./globalSurfaceRegistry";
import { PanelRegistry } from "./panelRegistry";
import {
  BUILTIN_PROJECT_ACTION_CONTRIBUTIONS,
  BUILTIN_PROJECT_FACTS_PROVIDERS,
  BUILTIN_PROJECT_LAYOUT_CONTRIBUTIONS,
} from "./builtinProjectAdapters";

export function modulePanelContributions(
  modules: readonly ShepModule[] = ENABLED_MODULES,
): readonly PanelContribution[] {
  return modules.flatMap((module) => module.panels ?? []);
}

export function moduleLegacyPanelDefinitions(
  modules: readonly ShepModule[] = ENABLED_MODULES,
): readonly LegacyPanelDefinition[] {
  return modulePanelContributions(modules).flatMap((panel) => panel.legacyTab
    ? [{
        kind: panel.legacyTab.kind,
        panelId: panel.id,
        label: panel.legacyTab.label ?? panel.label,
      }]
    : []);
}

export function moduleGlobalSurfaceContributions(
  modules: readonly ShepModule[] = ENABLED_MODULES,
): readonly GlobalSurfaceContribution[] {
  return modules.flatMap((module) => module.globalSurfaces ?? []);
}

export function moduleGlobalNavigationContributions(
  modules: readonly ShepModule[] = ENABLED_MODULES,
): readonly GlobalNavigationContribution[] {
  return modules.flatMap((module) => module.globalNavigation ?? []);
}

export function moduleProjectNavigationContributions(
  modules: readonly ShepModule[] = ENABLED_MODULES,
): readonly ProjectNavigationContribution[] {
  return modules
    .flatMap((module) => module.projectNavigation ?? [])
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
}

export function moduleProjectActionContributions(
  modules: readonly ShepModule[] = ENABLED_MODULES,
): readonly ProjectActionContribution[] {
  return modules
    .flatMap((module) => module.projectActions ?? [])
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
}

export function enabledProjectActionContributions(
  modules: readonly ShepModule[] = ENABLED_MODULES,
  builtin: readonly ProjectActionContribution[] = BUILTIN_PROJECT_ACTION_CONTRIBUTIONS,
): readonly ProjectActionContribution[] {
  return [...builtin, ...moduleProjectActionContributions(modules)]
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
}

export function moduleProjectLayoutContributions(
  modules: readonly ShepModule[] = ENABLED_MODULES,
): readonly ProjectLayoutContribution[] {
  return modules
    .flatMap((module) => module.projectLayout ?? [])
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
}

export function enabledProjectLayoutContributions(
  modules: readonly ShepModule[] = ENABLED_MODULES,
  builtin: readonly ProjectLayoutContribution[] = BUILTIN_PROJECT_LAYOUT_CONTRIBUTIONS,
): readonly ProjectLayoutContribution[] {
  return [...builtin, ...moduleProjectLayoutContributions(modules)]
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
}

export function moduleProjectFactsProviders(
  modules: readonly ShepModule[] = ENABLED_MODULES,
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
  modules: readonly ShepModule[] = ENABLED_MODULES,
  builtin: readonly ProjectFactsProviderContribution[] = BUILTIN_PROJECT_FACTS_PROVIDERS,
): ProjectFactsProviderContribution | null {
  return selectProjectFactsProvider([
    ...builtin,
    ...moduleProjectFactsProviders(modules),
  ]);
}

export function moduleSkillsProvider(
  modules: readonly ShepModule[] = ENABLED_MODULES,
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

export function createEnabledGlobalSurfaceRegistry(
  builtinLoaders: BuiltinGlobalSurfaceLoaders,
  modules: readonly ShepModule[] = ENABLED_MODULES,
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
