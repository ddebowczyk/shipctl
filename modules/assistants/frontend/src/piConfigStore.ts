import { create } from "zustand";
import type { AssistantLaunchClient } from "./assistantLaunchClient";
import type { PiCredentialClient } from "./credentialStoreClient";
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
  loadConfig: (client: AssistantLaunchClient) => Promise<void>;
  updateSettings: (
    patch: Partial<PiSettings>,
    client: AssistantLaunchClient,
  ) => Promise<void>;
  setApiKey: (provider: string, apiKey: string, client: PiCredentialClient) => Promise<void>;
  removeApiKey: (provider: string, client: PiCredentialClient) => Promise<void>;
}

export const usePiConfigStore = create<PiConfigStore>((set, get) => ({
  config: DEFAULT_CONFIG,
  hasLoaded: false,
  isSaving: false,
  error: null,

  loadConfig: async (client) => {
    try {
      const config = await client.getPiConfig();
      set({ config, hasLoaded: true, error: null });
    } catch (error) {
      set({
        hasLoaded: true,
        error: error instanceof Error ? error.message : "Failed to load pi config",
      });
    }
  },

  updateSettings: async (patch, client) => {
    const prev = get().config;
    const next: PiConfig = {
      ...prev,
      settings: {
        defaultProvider: patch.defaultProvider === undefined
          ? prev.settings.defaultProvider
          : patch.defaultProvider,
        defaultModel: patch.defaultModel === undefined
          ? prev.settings.defaultModel
          : patch.defaultModel,
        defaultThinkingLevel: patch.defaultThinkingLevel === undefined
          ? prev.settings.defaultThinkingLevel
          : patch.defaultThinkingLevel,
      },
    };
    set({ config: next, isSaving: true });
    try {
      await client.savePiSettings(next.settings);
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

  setApiKey: async (provider, apiKey, client) => {
    set({ isSaving: true });
    try {
      await client.saveApiKey(provider, apiKey);
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

  removeApiKey: async (provider, client) => {
    set({ isSaving: true });
    try {
      await client.deleteApiKey(provider);
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
