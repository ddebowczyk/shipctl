import type { BuiltinGlobalSurfaceLoaders } from "./builtinGlobalSurfaceAdapters";

export const BUILTIN_GLOBAL_SURFACE_LOADERS = {
  settings: async () => {
    const { default: SettingsPanel } = await import(
      "../../components/settings/SettingsPanel"
    );
    return { default: SettingsPanel };
  },
  usage: async () => {
    const { default: UsagePanel } = await import(
      "../../components/usage/UsagePanel"
    );
    return { default: UsagePanel };
  },
} satisfies BuiltinGlobalSurfaceLoaders;
