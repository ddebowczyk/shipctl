import { create } from "zustand";
import type { KeybindingSettings } from "@shipctl/core/platform";
import { getKeybindingSettings, saveKeybindingSettings } from "@shipctl/core/platform";

const DEFAULT_SETTINGS: KeybindingSettings = {
  shiftEnterNewline: true,
  optionDeleteWord: true,
  cmdKClear: true,
};

interface KeybindingStore {
  settings: KeybindingSettings;
  hasLoaded: boolean;
  isSaving: boolean;
  error: string | null;
  loadSettings: () => Promise<void>;
  setEnabled: (id: keyof KeybindingSettings, enabled: boolean) => Promise<void>;
}

export const useKeybindingStore = create<KeybindingStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  hasLoaded: false,
  isSaving: false,
  error: null,

  loadSettings: async () => {
    try {
      const settings = await getKeybindingSettings();
      set({ settings, hasLoaded: true, error: null });
    } catch (error) {
      set({ settings: DEFAULT_SETTINGS, hasLoaded: true, error: String(error) });
    }
  },

  setEnabled: async (id, enabled) => {
    const prev = get().settings;
    const next = { ...prev, [id]: enabled };
    // Optimistic update
    set({ settings: next, isSaving: true, error: null });
    try {
      await saveKeybindingSettings(next);
      set({ isSaving: false });
    } catch (error) {
      // Rollback
      set({ settings: prev, isSaving: false, error: String(error) });
    }
  },
}));
