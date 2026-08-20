import { create } from "zustand";
import {
  DEFAULT_TERMINAL_SETTINGS,
  hostConfigurationRuntime,
  type TerminalSettings,
} from "@shipctl/core/configuration";
import { setTerminalRetention } from "@shipctl/core/platform";
import { applyTerminalRetentionCommit, RETENTION_DEFAULT_BYTES } from "./terminalRetention.ts";

import { normalizeTerminalFontFamily, TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE } from "@shipctl/core/appearance";
import { ensureFamilyLoaded } from "@shipctl/core/appearance";

const DEFAULT_SETTINGS: TerminalSettings = {
  ...DEFAULT_TERMINAL_SETTINGS,
  scrollbackBytes: RETENTION_DEFAULT_BYTES,
  fontFamily: TERMINAL_FONT_FAMILY,
  fontSize: TERMINAL_FONT_SIZE,
};

interface TerminalSettingsStore {
  settings: TerminalSettings;
  /**
   * Retention revision of the committed settings. A response that carries a
   * lower revision describes an older policy and is discarded, so a delayed
   * save can never reinstate a value the user has already replaced.
   */
  retentionRevision: number;
  hasLoaded: boolean;
  isSaving: boolean;
  error: string | null;
  loadSettings: () => Promise<void>;
  updateSettings: (partial: Partial<TerminalSettings>) => Promise<void>;
}



export const useTerminalSettingsStore = create<TerminalSettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  retentionRevision: 0,
  hasLoaded: false,
  isSaving: false,
  error: null,

  loadSettings: async () => {
    try {
      const { value: storedSettings } = await hostConfigurationRuntime().resolve("terminal");
      const normalizedSettings = {
        ...storedSettings,
        fontFamily: normalizeTerminalFontFamily(storedSettings.fontFamily),
      };
      // Load font BEFORE publishing the new family name to the store so that
      // any terminal mounting concurrently doesn't measure against a face that
      // hasn't been registered yet.
      await ensureFamilyLoaded(normalizedSettings.fontFamily);
      if (normalizedSettings.fontFamily !== storedSettings.fontFamily) {
        await hostConfigurationRuntime().update("terminal", normalizedSettings);
      }
      const commit = await setTerminalRetention(normalizedSettings.scrollbackBytes);
      const accepted = applyTerminalRetentionCommit(
        { settings: get().settings, retentionRevision: get().retentionRevision },
        commit,
      );
      if (accepted.retentionRevision !== commit.retentionRevision) return;
      set({
        settings: normalizedSettings,
        retentionRevision: accepted.retentionRevision,
        hasLoaded: true,
        error: null,
      });
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
      // The TypeScript-owned record is committed before the terminal resource
      // consumes it. A later resource retry therefore converges to the durable
      // configuration instead of making native terminal state authoritative.
      await hostConfigurationRuntime().update("terminal", next);
      const commit = await setTerminalRetention(next.scrollbackBytes);
      const held = { settings: get().settings, retentionRevision: get().retentionRevision };
      const accepted = applyTerminalRetentionCommit(held, commit);
      if (accepted === held) {
        // A newer save already committed. Keep the newer state and only clear
        // the in-flight flag.
        set({ isSaving: false });
        return;
      }
      set({ settings: next, retentionRevision: accepted.retentionRevision, isSaving: false });
    } catch (error) {
      // Nothing to roll back: `settings` was never mutated, terminals were
      // never re-applied, and the font (if loaded) sitting in document.fonts
      // is harmless — it'll be reused next time the user picks it.
      set({ isSaving: false, error: String(error) });
    }
  },
}));
