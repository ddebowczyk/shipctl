import type { BuiltinGlobalSurfaceLoaders } from "./builtinGlobalSurfaceAdapters";

export const BUILTIN_GLOBAL_SURFACE_LOADERS = {
  settings: async () => {
    const { default: SettingsPanel } = await import(
      "../../components/settings/SettingsPanel"
    );
    return { default: SettingsPanel };
  },
} satisfies BuiltinGlobalSurfaceLoaders;
