import { create } from "zustand";
import type { TerminalSettings } from "@shipctl/core/platform";
import { getTerminalSettings, saveTerminalSettings } from "@shipctl/core/platform";
import { applyTerminalSettings } from "./terminalTheme.ts";

import { normalizeTerminalFontFamily, TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE } from "@shipctl/core/appearance";
import { ensureFamilyLoaded } from "@shipctl/core/appearance";

const DEFAULT_SETTINGS: TerminalSettings = {
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 10000,
  fontFamily: TERMINAL_FONT_FAMILY,
  fontSize: TERMINAL_FONT_SIZE,
  urlAllowlist: ["http", "https"],
};

interface TerminalSettingsStore {
  settings: TerminalSettings;
  hasLoaded: boolean;
  isSaving: boolean;
  error: string | null;
  loadSettings: () => Promise<void>;
  updateSettings: (partial: Partial<TerminalSettings>) => Promise<void>;
}

export const useTerminalSettingsStore = create<TerminalSettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  hasLoaded: false,
  isSaving: false,
  error: null,

  loadSettings: async () => {
    try {
      const settings = await getTerminalSettings();
      const normalizedSettings = {
        ...settings,
        fontFamily: normalizeTerminalFontFamily(settings.fontFamily),
      };
      // Load font BEFORE publishing the new family name to the store so that
      // any terminal mounting concurrently doesn't measure against a face that
      // hasn't been registered yet.
      await ensureFamilyLoaded(normalizedSettings.fontFamily);
      set({ settings: normalizedSettings, hasLoaded: true, error: null });
      applyTerminalSettings(normalizedSettings);
      if (normalizedSettings.fontFamily !== settings.fontFamily) {
        saveTerminalSettings(normalizedSettings).catch((error) => {
          set({ error: String(error) });
        });
      }
    } catch (error) {
      set({ settings: DEFAULT_SETTINGS, hasLoaded: true, error: String(error) });
    }
  },

  updateSettings: async (partial) => {
    const prev = get().settings;
    const next = {
      ...prev,
      ...partial,
      ...(partial.fontFamily !== undefined
        ? { fontFamily: normalizeTerminalFontFamily(partial.fontFamily) }
        : {}),
    };
    set({ isSaving: true, error: null });
    try {
      if (next.fontFamily !== prev.fontFamily) {
        await ensureFamilyLoaded(next.fontFamily);
      }
      // Persist to disk BEFORE committing to the store or applying to
      // terminals. If the save fails, `prev` remains the committed state —
      // the UI never shows a value that wasn't written. This avoids the
      // three-way inconsistency (store / terminals / disk) that the
      // optimistic pattern exposed on save failure.
      await saveTerminalSettings(next);
      set({ settings: next, isSaving: false });
      applyTerminalSettings(next);
    } catch (error) {
      // Nothing to roll back: `settings` was never mutated, terminals were
      // never re-applied, and the font (if loaded) sitting in document.fonts
      // is harmless — it'll be reused next time the user picks it.
      set({ isSaving: false, error: String(error) });
    }
  },
}));
