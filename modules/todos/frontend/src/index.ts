import {
  projectDocumentsService,
  type ModuleHostServices,
  type ShipctlModule,
} from "@shipctl/module-api";

import { useTodoStore } from "./store";
import "./todos.css";

export const TODOS_PANEL_ID = "todos.board" as const;

function enabled(services: ModuleHostServices) {
  return services.settings.getSnapshot().values.showTodos !== false;
}

export const todosModule = {
  id: "shipctl.todos",
  version: "0.0.0",
  panels: [
    {
      id: TODOS_PANEL_ID,
      moduleId: "shipctl.todos",
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
  ],
  projectNavigation: [
    {
      id: "todos.project-navigation",
      moduleId: "shipctl.todos",
      panelId: TODOS_PANEL_ID,
      order: 40,
      load: () => import("./TodoProjectRow"),
    },
  ],
  settings: [
    {
      id: "todos.settings",
      moduleId: "shipctl.todos",
      order: 40,
      load: () => import("./TodoSettingsSection"),
    },
  ],
  projectLifecycle: {
    onProjectsChanged(projectPaths, services, activation) {
      if (enabled(services)) {
        const documents = activation.services.require(projectDocumentsService);
        void useTodoStore.getState().refreshAll(documents, [...projectPaths]);
      }
    },
    onFilesystemChanged(projectPaths, services, activation) {
      if (enabled(services)) {
        const documents = activation.services.require(projectDocumentsService);
        void useTodoStore.getState().refreshAll(documents, [...projectPaths]);
      }
    },
    onProjectRemoved(projectPath) {
      useTodoStore.getState().removeProject(projectPath);
    },
  },
} as const satisfies ShipctlModule;
