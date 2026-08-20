import { create } from "zustand";
import {
  DEFAULT_SIDEBAR_SETTINGS,
  hostConfigurationRuntime,
  type SidebarSettings,
} from "@shipctl/core/configuration";

interface StandardWorkspaceSettingsStore {
  settings: SidebarSettings;
  hasLoaded: boolean;
  error: string | null;
  loadSettings: () => Promise<void>;
}

export const useStandardWorkspaceSettingsStore = create<StandardWorkspaceSettingsStore>((set) => ({
  settings: DEFAULT_SIDEBAR_SETTINGS,
  hasLoaded: false,
  error: null,

  loadSettings: async () => {
    try {
      const { value: settings } = await hostConfigurationRuntime().resolve("sidebar");
      set({ settings, hasLoaded: true, error: null });
    } catch (error) {
      set({ settings: DEFAULT_SIDEBAR_SETTINGS, hasLoaded: true, error: String(error) });
    }
  },
}));
