import { create } from "zustand";
import {
  DEFAULT_KEYBINDING_SETTINGS,
  hostConfigurationRuntime,
  type KeybindingSettings,
} from "@shipctl/core/configuration";

interface KeybindingStore {
  settings: KeybindingSettings;
  hasLoaded: boolean;
  isSaving: boolean;
  error: string | null;
  loadSettings: () => Promise<void>;
  setEnabled: (id: keyof KeybindingSettings, enabled: boolean) => Promise<void>;
}

export const useKeybindingStore = create<KeybindingStore>((set, get) => ({
  settings: DEFAULT_KEYBINDING_SETTINGS,
  hasLoaded: false,
  isSaving: false,
  error: null,

  loadSettings: async () => {
    try {
      const { value: settings } = await hostConfigurationRuntime().resolve("keybindings");
      set({ settings, hasLoaded: true, error: null });
    } catch (error) {
      set({ settings: DEFAULT_KEYBINDING_SETTINGS, hasLoaded: true, error: String(error) });
    }
  },

  setEnabled: async (id, enabled) => {
    const prev = get().settings;
    const next = { ...prev, [id]: enabled };
    // Optimistic update
    set({ settings: next, isSaving: true, error: null });
    try {
      await hostConfigurationRuntime().update("keybindings", next);
      set({ isSaving: false });
    } catch (error) {
      // Rollback
      set({ settings: prev, isSaving: false, error: String(error) });
    }
  },
}));
