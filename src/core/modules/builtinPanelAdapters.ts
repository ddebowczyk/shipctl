import type { PanelTabKind, TabKind } from "../../lib/types";
import type { PanelContribution } from "@shep/module-api";
import { PanelRegistry } from "./panelRegistry";
import { BUILTIN_PANEL_IDS } from "./panelPersistence";

type BuiltinPanelDefinition = Omit<PanelContribution, "load"> & {
  readonly legacyKind: CoreBuiltinPanelKind;
};

export type CoreBuiltinPanelKind = PanelTabKind;
export type BuiltinPanelLoaders = Readonly<
  Record<CoreBuiltinPanelKind, PanelContribution["load"]>
>;

export const BUILTIN_PANEL_DEFINITIONS = {
  git: {
    id: BUILTIN_PANEL_IDS.git,
    legacyKind: "git",
    moduleId: "core",
    scope: "project",
    label: "Files",
    icon: { name: "folder-tree" },
    shortcut: "⌘G",
    singleton: "per-project",
    order: 10,
    unavailable: {
      title: "Files panel unavailable",
      description: "The built-in Git and file browser could not be loaded.",
    },
  },
  commands: {
    id: BUILTIN_PANEL_IDS.commands,
    legacyKind: "commands",
    moduleId: "core",
    scope: "project",
    label: "Commands",
    icon: { name: "list" },
    shortcut: "⇧⌘C",
    singleton: "per-project",
    order: 20,
    unavailable: {
      title: "Commands panel unavailable",
      description: "The built-in command runner could not be loaded.",
    },
  },
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
} as const satisfies Record<Exclude<TabKind, PanelTabKind | "panel">, string>;

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
