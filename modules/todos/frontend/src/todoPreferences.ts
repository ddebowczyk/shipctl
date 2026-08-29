import {
  pluginDataService,
  type ConfigurationValidation,
  type ModuleActivationContext,
  type PluginDataErrorCode,
  type PluginDataRevision,
} from "@shipctl/module-api";
import { create } from "zustand";

export type TodoFileStyle = "kanban" | "list";

export type TodoPreferences = {
  readonly showTodos: boolean;
  readonly todoFileStyle: TodoFileStyle;
};

export const DEFAULT_TODO_PREFERENCES: TodoPreferences = Object.freeze({
  showTodos: true,
  todoFileStyle: "kanban",
});

export class TodoPreferencesError extends Error {
  constructor(readonly code: PluginDataErrorCode, message: string) {
    super(message);
    this.name = "TodoPreferencesError";
  }
}

interface TodoPreferencesState {
  readonly preferences: TodoPreferences | null;
  readonly revision: PluginDataRevision | null;
}

export const useTodoPreferencesStore = create<TodoPreferencesState>(() => ({
  preferences: null,
  revision: null,
}));

function preferences(value: unknown): TodoPreferences | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.showTodos !== "boolean") return null;
  if (candidate.todoFileStyle !== "kanban" && candidate.todoFileStyle !== "list") return null;
  return Object.freeze({
    showTodos: candidate.showTodos,
    todoFileStyle: candidate.todoFileStyle,
  });
}

export function validateTodoPreferences(value: unknown): ConfigurationValidation<TodoPreferences> {
  const parsed = preferences(value);
  return parsed === null
    ? {
      ok: false,
      diagnostic: {
        code: "todos.preferences.invalid",
        message: "To-do preferences require a boolean showTodos and a supported todoFileStyle.",
      },
    }
    : { ok: true, value: parsed };
}

let activeActivation: ModuleActivationContext | null = null;

function activeService() {
  if (activeActivation === null) {
    throw new Error("To-do preferences are unavailable outside an active plugin.");
  }
  return activeActivation.services.require(pluginDataService);
}

function expectationError(code: PluginDataErrorCode, message: string): TodoPreferencesError {
  return new TodoPreferencesError(code, message);
}

export function configureTodoPreferences(activation: ModuleActivationContext | null): void {
  activeActivation = activation;
  if (activation === null) {
    useTodoPreferencesStore.setState({ preferences: null, revision: null });
  }
}

export function releaseTodoPreferences(activation: ModuleActivationContext): void {
  if (activeActivation !== activation) return;
  configureTodoPreferences(null);
}

export async function loadTodoPreferences(): Promise<TodoPreferences | null> {
  const outcome = await activeService().readRecord.execute({
    scope: { kind: "global" },
    key: "preferences",
  });
  if (!outcome.result.ok) {
    throw expectationError(outcome.result.error.code, outcome.result.error.message);
  }
  if (outcome.result.value === null) {
    useTodoPreferencesStore.setState({ preferences: null, revision: null });
    return null;
  }
  const parsed = preferences(outcome.result.value.value);
  if (parsed === null) {
    throw expectationError("plugin-data.invalid-value", "Stored to-do preferences are invalid.");
  }
  useTodoPreferencesStore.setState({
    preferences: parsed,
    revision: outcome.result.value.revision,
  });
  return parsed;
}

export async function updateTodoPreferences(next: TodoPreferences): Promise<TodoPreferences> {
  const validation = validateTodoPreferences(next);
  if (!validation.ok) {
    throw new Error(validation.diagnostic.message);
  }
  const revision = useTodoPreferencesStore.getState().revision;
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
  useTodoPreferencesStore.setState({
    preferences: validation.value,
    revision: outcome.result.value.revision,
  });
  return validation.value;
}
