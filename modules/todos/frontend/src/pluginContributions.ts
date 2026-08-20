import {
  projectDocumentsService,
  projectsService,
  type ConfigurationContribution,
  type ModuleActivationContext,
  type PanelContribution,
  type ProjectNavigationContribution,
  type SettingsContribution,
} from "@shipctl/module-api";

import {
  configureTodoPreferences,
  loadTodoPreferences,
  useTodoPreferencesStore,
  type TodoPreferences,
  DEFAULT_TODO_PREFERENCES,
  validateTodoPreferences,
} from "./todoPreferences.ts";
import { useTodoStore } from "./store.ts";

export const TODOS_MODULE_ID = "shipctl.todos" as const;
export const TODOS_PLUGIN_VERSION = "0.0.0" as const;
export const TODOS_PANEL_ID = "todos.board" as const;

export const todosContributions = Object.freeze({
  configuration: Object.freeze([
    {
      id: "todos.preferences",
      moduleId: TODOS_MODULE_ID,
      scope: "global",
      key: "preferences",
      schemaVersion: 1,
      defaults: DEFAULT_TODO_PREFERENCES,
      validate: validateTodoPreferences,
    },
  ] satisfies readonly ConfigurationContribution<TodoPreferences>[]),
  panels: Object.freeze([
    {
      id: TODOS_PANEL_ID,
      moduleId: TODOS_MODULE_ID,
      scope: "project",
      label: "To-dos",
      icon: { name: "list-todo", label: "To-dos" },
      singleton: "per-project",
      order: 40,
      unavailable: {
        title: "To-dos panel unavailable",
        description: "The project to-do module could not be loaded.",
      },
      migrationAlias: { kind: "todos", label: "To-dos" },
      load: () => import("./TodosPanel"),
    },
  ] satisfies readonly PanelContribution[]),
  projectNavigation: Object.freeze([
    {
      id: "todos.project-navigation",
      moduleId: TODOS_MODULE_ID,
      panelId: TODOS_PANEL_ID,
      order: 40,
      load: () => import("./TodoProjectRow"),
    },
  ] satisfies readonly ProjectNavigationContribution[]),
  settings: Object.freeze([
    {
      id: "todos.settings",
      moduleId: TODOS_MODULE_ID,
      order: 40,
      load: () => import("./TodoSettingsSection"),
    },
  ] satisfies readonly SettingsContribution[]),
});

let activeRefresh: (() => Promise<void>) | null = null;

export function refreshActiveTodos(): Promise<void> {
  return activeRefresh?.() ?? Promise.resolve();
}

/**
 * Own Todo's project-document cache from the generic catalog resource. The
 * catalog remains the lifecycle authority; project documents remain the data
 * authority, including their revision and access failures.
 */
export async function activateTodosRuntime(
  activation: ModuleActivationContext,
): Promise<() => Promise<void>> {
  configureTodoPreferences(activation);
  try {
    await loadTodoPreferences();
    const documents = activation.services.require(projectDocumentsService);
    const projects = activation.services.require(projectsService);
    let currentProjectIds: readonly string[] = [];
    const refresh = async (projectIds: readonly string[]) => {
      currentProjectIds = [...projectIds];
      if (useTodoPreferencesStore.getState().preferences?.showTodos === false) return;
      await useTodoStore.getState().refreshAll(documents, [...projectIds]);
    };
    const subscription = await projects.observeProjects.subscribe("catalog", async ({ value }) => {
      switch (value.kind) {
        case "catalog-changed":
          await refresh(value.projectIds);
          break;
        case "filesystem-changed":
          await refresh(value.projectIds);
          break;
        case "project-removed":
          currentProjectIds = currentProjectIds.filter((projectId) => projectId !== value.projectId);
          useTodoStore.getState().removeProject(value.projectId);
          break;
      }
    });
    const initial = await projects.listProjects.execute({});
    if (initial.result.ok) await refresh(initial.result.value.projectIds);
    const active = async () => refresh(currentProjectIds);
    activeRefresh = active;

    return async () => {
      if (activeRefresh === active) activeRefresh = null;
      await subscription.dispose();
      configureTodoPreferences(null);
    };
  } catch (error) {
    configureTodoPreferences(null);
    throw error;
  }
}
