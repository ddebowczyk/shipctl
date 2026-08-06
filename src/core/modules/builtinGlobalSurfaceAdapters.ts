import type {
  GlobalNavigationContribution,
  GlobalSurfaceContribution,
} from "@shep/module-api";

export type BuiltinGlobalSurfaceKind = "ports" | "settings" | "usage";
export type BuiltinGlobalSurfaceLoaders = Readonly<
  Record<BuiltinGlobalSurfaceKind, GlobalSurfaceContribution["load"]>
>;

export const BUILTIN_GLOBAL_SURFACE_IDS = {
  settings: "core.settings",
  usage: "core.usage",
  ports: "core.ports",
} as const;

const BUILTIN_GLOBAL_SURFACE_DEFINITIONS = {
  settings: {
    id: BUILTIN_GLOBAL_SURFACE_IDS.settings,
    moduleId: "core",
    unavailable: {
      title: "Settings unavailable",
      description: "The built-in settings surface could not be loaded.",
    },
  },
  usage: {
    id: BUILTIN_GLOBAL_SURFACE_IDS.usage,
    moduleId: "core",
    unavailable: {
      title: "Usage unavailable",
      description: "The built-in usage surface could not be loaded.",
    },
  },
  ports: {
    id: BUILTIN_GLOBAL_SURFACE_IDS.ports,
    moduleId: "core",
    unavailable: {
      title: "Ports unavailable",
      description: "The built-in ports surface could not be loaded.",
    },
  },
} as const satisfies Record<
  BuiltinGlobalSurfaceKind,
  Omit<GlobalSurfaceContribution, "load">
>;

export const BUILTIN_GLOBAL_NAVIGATION = [
  {
    id: "core.settings-navigation",
    moduleId: "core",
    surfaceId: BUILTIN_GLOBAL_SURFACE_IDS.settings,
    label: "Settings",
    icon: { name: "settings" },
    order: 10,
  },
  {
    id: "core.usage-navigation",
    moduleId: "core",
    surfaceId: BUILTIN_GLOBAL_SURFACE_IDS.usage,
    label: "Usage",
    icon: { name: "chart-no-axes-combined" },
    order: 20,
  },
  {
    id: "core.ports-navigation",
    moduleId: "core",
    surfaceId: BUILTIN_GLOBAL_SURFACE_IDS.ports,
    label: "Ports",
    icon: { name: "radio" },
    order: 30,
  },
] as const satisfies readonly GlobalNavigationContribution[];

export function createBuiltinGlobalSurfaceContributions(
  loaders: BuiltinGlobalSurfaceLoaders,
): readonly GlobalSurfaceContribution[] {
  return (Object.entries(BUILTIN_GLOBAL_SURFACE_DEFINITIONS) as readonly [
    BuiltinGlobalSurfaceKind,
    (typeof BUILTIN_GLOBAL_SURFACE_DEFINITIONS)[BuiltinGlobalSurfaceKind],
  ][]).map(([kind, definition]) => ({
    ...definition,
    load: loaders[kind],
  }));
}
