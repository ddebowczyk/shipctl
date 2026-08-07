import type { TabKind } from "../../lib/types";
import type { PanelContribution } from "@shep/module-api";
import { PanelRegistry } from "./panelRegistry";
import { BUILTIN_PANEL_IDS } from "./panelPersistence";

type BuiltinPanelDefinition = Omit<PanelContribution, "load"> & {
  readonly legacyKind: CoreBuiltinPanelKind;
};

export type CoreBuiltinPanelKind = "launcher";
export type BuiltinPanelLoaders = Readonly<
  Record<CoreBuiltinPanelKind, PanelContribution["load"]>
>;

export const BUILTIN_PANEL_DEFINITIONS = {
  launcher: {
    id: BUILTIN_PANEL_IDS.launcher,
    legacyKind: "launcher",
    moduleId: "core",
    scope: "project",
    label: "New Agent",
    icon: { name: "square-terminal" },
    singleton: "per-project",
    order: 30,
    unavailable: {
      title: "Agent launcher unavailable",
      description: "The built-in agent launcher could not be loaded.",
    },
  },
} as const satisfies Record<CoreBuiltinPanelKind, BuiltinPanelDefinition>;

export const CORE_TAB_EXCEPTIONS = {
  terminal: "PTY-backed tabs remain owned by terminal infrastructure.",
  assistant: "PTY-backed assistant tabs remain owned by terminal infrastructure.",
} as const satisfies Partial<Record<TabKind, string>>;

export const CORE_SURFACE_EXCEPTIONS = {
  "diff-summary": "layout-slot",
  skills: "embedded-settings-and-sidebar-capability",
} as const;

export function createBuiltinPanelContributions(
  loaders: BuiltinPanelLoaders,
): readonly PanelContribution[] {
  return Object.values(BUILTIN_PANEL_DEFINITIONS).map((definition) => ({
    ...definition,
    load: loaders[definition.legacyKind],
  }));
}

export function createBuiltinPanelRegistry(
  loaders: BuiltinPanelLoaders,
): PanelRegistry {
  return PanelRegistry.create(createBuiltinPanelContributions(loaders));
}
