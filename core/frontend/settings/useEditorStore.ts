import { create } from "zustand";
import type { EditorSettings, PreferredEditor } from "@shipctl/core/platform";
import { getEditorSettings, saveEditorSettings } from "@shipctl/core/platform";

const DEFAULT_SETTINGS: EditorSettings = {
  preferredEditor: null,
};

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
  settings: DEFAULT_SETTINGS,
  hasLoaded: false,
  isSaving: false,
  error: null,

  loadSettings: async () => {
    try {
      const settings = await getEditorSettings();
      set({ settings, hasLoaded: true, error: null });
    } catch (error) {
      set({
        settings: DEFAULT_SETTINGS,
        hasLoaded: true,
        error: String(error),
      });
    }
  },

  setPreferredEditor: async (editor) => {
    const nextSettings = { preferredEditor: editor };
    set({ isSaving: true, error: null });
    try {
      await saveEditorSettings(nextSettings);
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
