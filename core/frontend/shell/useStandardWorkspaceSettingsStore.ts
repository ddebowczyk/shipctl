import { create } from "zustand";
import {
  DEFAULT_SIDEBAR_SETTINGS,
  hostConfigurationRuntime,
  type SidebarSettings,
} from "@shipctl/core/configuration";

interface SidebarSettingsPatch {
  fontSize?: number;
  fontFamily?: string;
  width?: number;
}

interface StandardWorkspaceSettingsStore {
  settings: SidebarSettings;
  hasLoaded: boolean;
  isSaving: boolean;
  error: string | null;
  loadSettings: () => Promise<void>;
  updateSettings: (partial: SidebarSettingsPatch) => Promise<void>;
}

export const useStandardWorkspaceSettingsStore = create<StandardWorkspaceSettingsStore>((set, get) => ({
  settings: DEFAULT_SIDEBAR_SETTINGS,
  hasLoaded: false,
  isSaving: false,
  error: null,

  loadSettings: async () => {
    try {
      const { value: settings } = await hostConfigurationRuntime().resolve("sidebar");
      set({ settings, hasLoaded: true, error: null });
    } catch (error) {
      set({ settings: DEFAULT_SIDEBAR_SETTINGS, hasLoaded: true, error: String(error) });
    }
  },

  updateSettings: async (partial) => {
    const previous = get().settings;
    const next = { ...previous, ...partial };
    set({ settings: next, isSaving: true, error: null });
    try {
      await hostConfigurationRuntime().update("sidebar", next);
      set({ isSaving: false, hasLoaded: true });
    } catch (error) {
      set({ settings: previous, isSaving: false, error: String(error) });
      throw error;
    }
  },
}));
