import { create } from "zustand";
import { buildCustomTheme } from "./customThemes.ts";
import { DEFAULT_THEME_ID, THEMES } from "./themes.ts";
import type { ShipctlTheme } from "./themes.ts";
import { saveAppearanceState } from "../platform/index.ts";

function isThemeRecord(value: unknown): value is ShipctlTheme {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string"
    && typeof candidate.name === "string"
    && typeof candidate.appBg === "string"
    && typeof candidate.appFg === "string"
    && typeof candidate.termForeground === "string";
}

function resolveTheme(id: string, customTheme: ShipctlTheme | null): ShipctlTheme {
  if (id === customTheme?.id) return customTheme;
  return THEMES[id] ?? THEMES[DEFAULT_THEME_ID];
}

interface ThemeStore {
  themeId: string;
  theme: ShipctlTheme;
  customTheme: ShipctlTheme | null;
  hydrate: (themeId: string | null, customTheme: unknown) => void;
  setTheme: (id: string) => Promise<void>;
  importTheme: (source: string) => Promise<ShipctlTheme>;
}

const initialTheme = resolveTheme(DEFAULT_THEME_ID, null);

export const useThemeStore = create<ThemeStore>((set, get) => ({
  themeId: initialTheme.id,
  theme: initialTheme,
  customTheme: null,
  hydrate: (themeId: string | null, candidate: unknown) => {
    const customTheme = isThemeRecord(candidate) ? candidate : null;
    const theme = resolveTheme(themeId ?? DEFAULT_THEME_ID, customTheme);
    set({ themeId: theme.id, theme, customTheme });
  },
  setTheme: async (id: string) => {
    const theme = resolveTheme(id, get().customTheme);
    set({ themeId: theme.id, theme });
    await saveAppearanceState(theme.id, get().customTheme);
  },
  importTheme: async (source: string) => {
    const imported = buildCustomTheme(source);
    set({
      customTheme: imported,
      themeId: imported.id,
      theme: imported,
    });
    await saveAppearanceState(imported.id, imported);
    return imported;
  },
}));
