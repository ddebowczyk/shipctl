import { create } from "zustand";
import type { SidebarSettings } from "@shipctl/core/platform";
import { getSidebarSettings } from "@shipctl/core/platform";

const DEFAULT_SETTINGS: SidebarSettings = {
  fontSize: 13,
  fontFamily: "SF Pro Display, IBM Plex Sans, Segoe UI, sans-serif",
  width: 288,
};

interface SidebarSettingsStore {
  settings: SidebarSettings;
  hasLoaded: boolean;
  error: string | null;
  loadSettings: () => Promise<void>;
}

export const useSidebarSettingsStore = create<SidebarSettingsStore>((set) => ({
  settings: DEFAULT_SETTINGS,
  hasLoaded: false,
  error: null,

  loadSettings: async () => {
    try {
      const settings = await getSidebarSettings();
      set({ settings, hasLoaded: true, error: null });
    } catch (error) {
      set({ settings: DEFAULT_SETTINGS, hasLoaded: true, error: String(error) });
    }
  },
}));
