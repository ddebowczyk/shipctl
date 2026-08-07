import type { BuiltinGlobalSurfaceLoaders } from "../host/index.ts";

export const BUILTIN_GLOBAL_SURFACE_LOADERS = {
  settings: async () => {
    const { default: SettingsPanel } = await import(
      "./SettingsPanel.tsx"
    );
    return { default: SettingsPanel };
  },
} satisfies BuiltinGlobalSurfaceLoaders;
