import type { ModuleHostServices, ShepModule } from "@shep/module-api";

import { useTodoStore } from "./store";
import "./todos.css";

export const TODOS_PANEL_ID = "todos.board" as const;

function enabled(services: ModuleHostServices) {
  return services.settings.getSnapshot().values.showTodos !== false;
}

export const todosModule = {
  id: "shep.todos",
  version: "0.0.0",
  panels: [
    {
      id: TODOS_PANEL_ID,
      moduleId: "shep.todos",
      scope: "project",
      label: "To-dos",
      icon: { name: "list-todo", label: "To-dos" },
      singleton: "per-project",
      order: 40,
      unavailable: {
        title: "To-dos panel unavailable",
        description: "The project to-do module could not be loaded.",
      },
      legacyTab: { kind: "todos", label: "To-dos" },
      load: () => import("./TodosPanel"),
    },
  ],
  projectNavigation: [
    {
      id: "todos.project-navigation",
      moduleId: "shep.todos",
      panelId: TODOS_PANEL_ID,
      order: 40,
      load: () => import("./TodoProjectRow"),
    },
  ],
  settings: [
    {
      id: "todos.settings",
      moduleId: "shep.todos",
      order: 40,
      load: () => import("./TodoSettingsSection"),
    },
  ],
  projectLifecycle: {
    onProjectsChanged(projectPaths, services) {
      if (enabled(services)) void useTodoStore.getState().refreshAll([...projectPaths]);
    },
    onFilesystemChanged(projectPaths, services) {
      if (enabled(services)) void useTodoStore.getState().refreshAll([...projectPaths]);
    },
    onProjectRemoved(projectPath) {
      useTodoStore.getState().removeProject(projectPath);
    },
  },
} as const satisfies ShepModule;
