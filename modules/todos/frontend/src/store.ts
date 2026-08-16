import type {
  ProjectDocumentsErrorCode,
  ProjectDocumentsService,
  SemanticRequestOutcome,
} from "@shipctl/module-api";
import { create } from "zustand";

import {
  addTodoContents,
  createTodoContents,
  moveTodoContents,
  parseTodoDocument,
  toggleTodoContents,
} from "./todoDocuments";
import type { TodoFile } from "./types";

interface TodoStore {
  /** Project documents remain the source of truth. This is only a render cache. */
  projectTodos: Record<string, TodoFile[]>;
  refreshTodos: (documents: ProjectDocumentsService, projectId: string) => Promise<void>;
  refreshAll: (documents: ProjectDocumentsService, projectIds: string[]) => Promise<void>;
  toggleItem: (
    documents: ProjectDocumentsService,
    file: TodoFile,
    line: number,
    expectedText: string,
    checked: boolean,
  ) => Promise<void>;
  addItem: (
    documents: ProjectDocumentsService,
    projectId: string,
    file: TodoFile | null,
    text: string,
    sectionLine: number | null,
    kanban: boolean,
  ) => Promise<void>;
  moveItem: (
    documents: ProjectDocumentsService,
    file: TodoFile,
    line: number,
    expectedText: string,
    targetSectionLine: number,
    setChecked: boolean | null,
  ) => Promise<void>;
  removeProject: (projectId: string) => void;
}

class ProjectDocumentRequestError extends Error {
  readonly code: ProjectDocumentsErrorCode;

  constructor(code: ProjectDocumentsErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function resultValue<Value>(
  outcome: SemanticRequestOutcome<Value, ProjectDocumentsErrorCode>,
): Value {
  if (outcome.result.ok) return outcome.result.value;
  throw new ProjectDocumentRequestError(outcome.result.error.code, outcome.result.error.message);
}

async function readTodos(
  documents: ProjectDocumentsService,
  projectId: string,
): Promise<TodoFile[]> {
  const outcome = await documents.discoverDocuments.execute({
    projectId,
    fileNames: ["todo.md", "todos.md"],
  });
  return resultValue(outcome).map(parseTodoDocument);
}

function todoFilesEqual(a: readonly TodoFile[] | undefined, b: readonly TodoFile[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((file, index) =>
    file.projectId === b[index].projectId
    && file.relativePath === b[index].relativePath
    && file.revision === b[index].revision);
}

export const useTodoStore = create<TodoStore>((set, get) => ({
  projectTodos: {},

  refreshTodos: async (documents, projectId) => {
    try {
      const files = await readTodos(documents, projectId);
      set((state) =>
        todoFilesEqual(state.projectTodos[projectId], files)
          ? state
          : { projectTodos: { ...state.projectTodos, [projectId]: files } });
    } catch {
      // The project may have left the authorized catalog. Keep the last render cache.
    }
  },

  refreshAll: async (documents, projectIds) => {
    const results = await Promise.allSettled(
      projectIds.map((projectId) => readTodos(documents, projectId)),
    );
    set((state) => {
      let changed = false;
      const nextTodos = { ...state.projectTodos };
      for (let index = 0; index < projectIds.length; index += 1) {
        const result = results[index];
        const projectId = projectIds[index];
        if (
          result.status === "fulfilled"
          && !todoFilesEqual(state.projectTodos[projectId], result.value)
        ) {
          nextTodos[projectId] = result.value;
          changed = true;
        }
      }
      return changed ? { projectTodos: nextTodos } : state;
    });
  },

  toggleItem: async (documents, file, line, expectedText, checked) => {
    try {
      const contents = toggleTodoContents(file.contents, line, expectedText, checked);
      resultValue(await documents.writeDocument.execute({
        projectId: file.projectId,
        relativePath: file.relativePath,
        expectedRevision: file.revision,
        contents,
      }));
    } finally {
      await get().refreshTodos(documents, file.projectId);
    }
  },

  addItem: async (documents, projectId, file, text, sectionLine, kanban) => {
    const relativePath = file?.relativePath ?? "TODO.md";
    const contents = file
      ? addTodoContents(file.contents, text, sectionLine)
      : createTodoContents(text, kanban);
    try {
      resultValue(await documents.writeDocument.execute({
        projectId,
        relativePath,
        expectedRevision: file?.revision ?? null,
        contents,
      }));
    } finally {
      await get().refreshTodos(documents, projectId);
    }
  },

  moveItem: async (
    documents,
    file,
    line,
    expectedText,
    targetSectionLine,
    setChecked,
  ) => {
    try {
      const contents = moveTodoContents(
        file.contents,
        line,
        expectedText,
        targetSectionLine,
        setChecked,
      );
      resultValue(await documents.writeDocument.execute({
        projectId: file.projectId,
        relativePath: file.relativePath,
        expectedRevision: file.revision,
        contents,
      }));
    } finally {
      await get().refreshTodos(documents, file.projectId);
    }
  },

  removeProject: (projectId) => {
    set((state) => {
      const { [projectId]: _, ...rest } = state.projectTodos;
      return { projectTodos: rest };
    });
  },
}));
