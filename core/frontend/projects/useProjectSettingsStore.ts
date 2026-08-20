import { create } from "zustand";
import {
  DEFAULT_PROJECT_SETTINGS,
  hostConfigurationRuntime,
  type ProjectSettings,
  type ProjectSettingsPatch,
} from "@shipctl/core/configuration";

interface ProjectSettingsStore {
  settings: ProjectSettings;
  hasLoaded: boolean;
  isSaving: boolean;
  error: string | null;
  loadSettings: () => Promise<void>;
  updateSettings: (partial: ProjectSettingsPatch) => Promise<void>;
}

export const useProjectSettingsStore = create<ProjectSettingsStore>((set, get) => ({
  settings: DEFAULT_PROJECT_SETTINGS,
  hasLoaded: false,
  isSaving: false,
  error: null,

  loadSettings: async () => {
    try {
      const { value: settings } = await hostConfigurationRuntime().resolve("projects");
      set({ settings, hasLoaded: true, error: null });
    } catch (error) {
      set({ settings: DEFAULT_PROJECT_SETTINGS, hasLoaded: true, error: String(error) });
    }
  },

  updateSettings: async (partial) => {
    const prev = get().settings;
    const next = { ...prev, ...partial };
    set({ settings: next, isSaving: true, error: null });
    try {
      await hostConfigurationRuntime().update("projects", next);
      set({ isSaving: false, hasLoaded: true });
    } catch (error) {
      set({ settings: prev, isSaving: false, error: String(error) });
    }
  },
}));
