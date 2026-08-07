import { create } from "zustand";
import { deletePiApiKey, getPiConfig, savePiApiKey, savePiSettings } from "./client";
import type { PiConfig, PiSettings } from "./types";

const DEFAULT_CONFIG: PiConfig = {
  settings: { defaultProvider: null, defaultModel: null, defaultThinkingLevel: null },
  configuredProviders: [],
};

interface PiConfigStore {
  config: PiConfig;
  hasLoaded: boolean;
  isSaving: boolean;
  error: string | null;
  loadConfig: () => Promise<void>;
  updateSettings: (patch: Partial<PiSettings>) => Promise<void>;
  setApiKey: (provider: string, apiKey: string) => Promise<void>;
  removeApiKey: (provider: string) => Promise<void>;
}

export const usePiConfigStore = create<PiConfigStore>((set, get) => ({
  config: DEFAULT_CONFIG,
  hasLoaded: false,
  isSaving: false,
  error: null,

  loadConfig: async () => {
    try {
      const config = await getPiConfig();
      set({ config, hasLoaded: true, error: null });
    } catch (error) {
      set({
        hasLoaded: true,
        error: error instanceof Error ? error.message : "Failed to load pi config",
      });
    }
  },

  updateSettings: async (patch) => {
    const prev = get().config;
    const next: PiConfig = {
      ...prev,
      settings: { ...prev.settings, ...patch },
    };
    set({ config: next, isSaving: true });
    try {
      await savePiSettings(next.settings);
      set({ isSaving: false, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save pi settings";
      set({
        config: prev,
        isSaving: false,
        error: message,
      });
      throw new Error(message);
    }
  },

  setApiKey: async (provider, apiKey) => {
    set({ isSaving: true });
    try {
      await savePiApiKey(provider, apiKey);
      const prev = get().config;
      const configured = prev.configuredProviders.includes(provider)
        ? prev.configuredProviders
        : [...prev.configuredProviders, provider].sort();
      set({ config: { ...prev, configuredProviders: configured }, isSaving: false, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save API key";
      set({
        isSaving: false,
        error: message,
      });
      throw new Error(message);
    }
  },

  removeApiKey: async (provider) => {
    set({ isSaving: true });
    try {
      await deletePiApiKey(provider);
      const prev = get().config;
      set({
        config: {
          ...prev,
          configuredProviders: prev.configuredProviders.filter((p) => p !== provider),
        },
        isSaving: false,
        error: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to remove API key";
      set({
        isSaving: false,
        error: message,
      });
      throw new Error(message);
    }
  },
}));
