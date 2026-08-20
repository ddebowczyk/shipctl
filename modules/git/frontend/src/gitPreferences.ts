import {
  pluginDataService,
  type ConfigurationValidation,
  type ModuleActivationContext,
  type PluginDataErrorCode,
  type PluginDataRevision,
} from "@shipctl/module-api";
import { create } from "zustand";

export type GitPreferences = {
  readonly autoImportWorktrees: boolean;
};

export const DEFAULT_GIT_PREFERENCES: GitPreferences = Object.freeze({
  autoImportWorktrees: true,
});

export class GitPreferencesError extends Error {
  constructor(readonly code: PluginDataErrorCode, message: string) {
    super(message);
    this.name = "GitPreferencesError";
  }
}

interface GitPreferencesState {
  readonly preferences: GitPreferences | null;
  readonly revision: PluginDataRevision | null;
}

export const useGitPreferencesStore = create<GitPreferencesState>(() => ({
  preferences: null,
  revision: null,
}));

function preferences(value: unknown): GitPreferences | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.autoImportWorktrees !== "boolean") return null;
  return Object.freeze({ autoImportWorktrees: candidate.autoImportWorktrees });
}

export function validateGitPreferences(value: unknown): ConfigurationValidation<GitPreferences> {
  const parsed = preferences(value);
  return parsed === null
    ? {
      ok: false,
      diagnostic: {
        code: "git.preferences.invalid",
        message: "Git preferences require a boolean autoImportWorktrees value.",
      },
    }
    : { ok: true, value: parsed };
}

let activeActivation: ModuleActivationContext | null = null;

function activeService() {
  if (activeActivation === null) {
    throw new Error("Git preferences are unavailable outside an active plugin.");
  }
  return activeActivation.services.require(pluginDataService);
}

function expectationError(code: PluginDataErrorCode, message: string): GitPreferencesError {
  return new GitPreferencesError(code, message);
}

export function configureGitPreferences(activation: ModuleActivationContext | null): void {
  activeActivation = activation;
  if (activation === null) {
    useGitPreferencesStore.setState({ preferences: null, revision: null });
  }
}

export async function loadGitPreferences(): Promise<GitPreferences | null> {
  const outcome = await activeService().readRecord.execute({
    scope: { kind: "global" },
    key: "preferences",
  });
  if (!outcome.result.ok) {
    throw expectationError(outcome.result.error.code, outcome.result.error.message);
  }
  if (outcome.result.value === null) {
    useGitPreferencesStore.setState({ preferences: null, revision: null });
    return null;
  }
  const parsed = preferences(outcome.result.value.value);
  if (parsed === null) {
    throw expectationError("plugin-data.invalid-value", "Stored Git preferences are invalid.");
  }
  useGitPreferencesStore.setState({
    preferences: parsed,
    revision: outcome.result.value.revision,
  });
  return parsed;
}

export async function updateGitPreferences(next: GitPreferences): Promise<GitPreferences> {
  const validation = validateGitPreferences(next);
  if (!validation.ok) {
    throw new Error(validation.diagnostic.message);
  }
  const revision = useGitPreferencesStore.getState().revision;
  const outcome = await activeService().writeRecord.execute({
    scope: { kind: "global" },
    key: "preferences",
    expectedRevision: revision,
    schemaVersion: 1,
    value: validation.value,
  });
  if (!outcome.result.ok) {
    throw expectationError(outcome.result.error.code, outcome.result.error.message);
  }
  useGitPreferencesStore.setState({
    preferences: validation.value,
    revision: outcome.result.value.revision,
  });
  return validation.value;
}
