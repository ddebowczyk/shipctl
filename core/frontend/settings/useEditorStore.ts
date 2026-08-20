import { create } from "zustand";
import {
  DEFAULT_EDITOR_SETTINGS,
  hostConfigurationRuntime,
  type EditorSettings,
  type PreferredEditor,
} from "@shipctl/core/configuration";

interface EditorStore {
  settings: EditorSettings;
  hasLoaded: boolean;
  isSaving: boolean;
  error: string | null;
  loadSettings: () => Promise<void>;
  setPreferredEditor: (editor: PreferredEditor | null) => Promise<void>;
  clearError: () => void;
}

export const useEditorStore = create<EditorStore>((set) => ({
  settings: DEFAULT_EDITOR_SETTINGS,
  hasLoaded: false,
  isSaving: false,
  error: null,

  loadSettings: async () => {
    try {
      const { value: settings } = await hostConfigurationRuntime().resolve("editor");
      set({ settings, hasLoaded: true, error: null });
    } catch (error) {
      set({
        settings: DEFAULT_EDITOR_SETTINGS,
        hasLoaded: true,
        error: String(error),
      });
    }
  },

  setPreferredEditor: async (editor) => {
    const nextSettings = { preferredEditor: editor };
    set({ isSaving: true, error: null });
    try {
      await hostConfigurationRuntime().update("editor", nextSettings);
      set({
        settings: nextSettings,
        isSaving: false,
        hasLoaded: true,
      });
    } catch (error) {
      set({ isSaving: false, error: String(error) });
    }
  },

  clearError: () => set({ error: null }),
}));
