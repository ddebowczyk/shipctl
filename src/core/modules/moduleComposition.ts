import type { PanelContribution, ShepModule } from "@shep/module-api";

import type { BuiltinPanelLoaders } from "./builtinPanelAdapters";
import { createBuiltinPanelContributions } from "./builtinPanelAdapters";
import { ENABLED_MODULES } from "./enabledModules";
import { PanelRegistry } from "./panelRegistry";

export function modulePanelContributions(
  modules: readonly ShepModule[],
): readonly PanelContribution[] {
  return modules.flatMap((module) => module.panels ?? []);
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
