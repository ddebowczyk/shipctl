import { create } from "zustand";
import type { ModuleGlobalDataPort } from "@shipctl/module-api";
import type { UsageSettings, UsageProvider, ProviderBudgetConfig } from "./types";

const USAGE_SETTINGS_KEY = "usage";

const DEFAULT_SETTINGS: UsageSettings = {
  claude: { show: true, budgetMode: "subscription", monthlyBudget: null },
  codex: { show: true, budgetMode: "subscription", monthlyBudget: null },
  antigravity: { show: true, budgetMode: "subscription", monthlyBudget: null },
  gemini: { show: false, budgetMode: "subscription", monthlyBudget: null },
  opencode: { show: true, budgetMode: "custom", monthlyBudget: 100 },
  pi: { show: false, budgetMode: "custom", monthlyBudget: null },
};

let globalData: ModuleGlobalDataPort | null = null;
let persistedDocument: Record<string, unknown> = {};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeProvider(
  value: unknown,
  defaults: ProviderBudgetConfig,
): ProviderBudgetConfig {
  const provider = asRecord(value);
  return {
    show: typeof provider.show === "boolean" ? provider.show : defaults.show,
    budgetMode: provider.budgetMode === "subscription" || provider.budgetMode === "custom"
      ? provider.budgetMode
      : defaults.budgetMode,
    monthlyBudget: typeof provider.monthlyBudget === "number" || provider.monthlyBudget === null
      ? provider.monthlyBudget
      : defaults.monthlyBudget,
  };
}

function normalizeSettings(value: unknown): UsageSettings {
  const document = asRecord(value);
  return Object.fromEntries(
    (Object.keys(DEFAULT_SETTINGS) as UsageProvider[]).map((provider) => [
      provider,
      normalizeProvider(document[provider], DEFAULT_SETTINGS[provider]),
    ]),
  ) as unknown as UsageSettings;
}

function mergeSettingsDocument(settings: UsageSettings): Record<string, unknown> {
  return Object.fromEntries([
    ...Object.entries(persistedDocument),
    ...(Object.keys(DEFAULT_SETTINGS) as UsageProvider[]).map((provider) => [
      provider,
      { ...asRecord(persistedDocument[provider]), ...settings[provider] },
    ]),
  ]);
}

export function configureUsageSettingsPersistence(port: ModuleGlobalDataPort | null) {
  globalData = port;
  if (!port) persistedDocument = {};
}

function persistence(): ModuleGlobalDataPort {
  if (!globalData) throw new Error("Usage settings persistence is unavailable");
  return globalData;
}

interface UsageSettingsStore {
  settings: UsageSettings;
  hasLoaded: boolean;
  isSaving: boolean;
  error: string | null;
  loadSettings: () => Promise<void>;
  updateProvider: (provider: UsageProvider, patch: Partial<ProviderBudgetConfig>) => Promise<void>;
  isProviderEnabled: (provider: UsageProvider) => boolean;
  getProviderConfig: (provider: UsageProvider) => ProviderBudgetConfig;
}

export const useUsageSettingsStore = create<UsageSettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  hasLoaded: false,
  isSaving: false,
  error: null,
  loadSettings: async () => {
    try {
      const value = await persistence().read(USAGE_SETTINGS_KEY);
      persistedDocument = asRecord(value);
      const settings = normalizeSettings(value);
      set({ settings, hasLoaded: true, error: null });
    } catch (error) {
      set({
        hasLoaded: true,
        error: error instanceof Error ? error.message : "Failed to load usage settings",
      });
    }
  },
  updateProvider: async (provider, patch) => {
    const prev = get().settings;
    const next = { ...prev, [provider]: { ...prev[provider], ...patch } };
    set({ settings: next, isSaving: true });
    try {
      const document = mergeSettingsDocument(next);
      await persistence().replace(USAGE_SETTINGS_KEY, document);
      persistedDocument = document;
      set({ isSaving: false, error: null });
    } catch (error) {
      set({
        settings: prev,
        isSaving: false,
        error: error instanceof Error ? error.message : "Failed to save usage settings",
      });
    }
  },
  isProviderEnabled: (provider) => get().settings[provider].show,
  getProviderConfig: (provider) => get().settings[provider],
}));
