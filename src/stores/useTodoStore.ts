import { create } from "zustand";
import type { TodoFile } from "../lib/types";
import { readTodos, toggleTodo, addTodo, moveTodo } from "../lib/tauri";

interface TodoStore {
  /** TODO.md files per repo. The file on disk is the source of truth — this
   *  is only a render cache, refreshed from fs events and after every write. */
  projectTodos: Record<string, TodoFile[]>;
  refreshTodos: (repoPath: string) => Promise<void>;
  refreshAll: (repoPaths: string[]) => Promise<void>;
  toggleItem: (
    repoPath: string,
    filePath: string,
    line: number,
    expectedText: string,
    checked: boolean,
  ) => Promise<void>;
  addItem: (
    repoPath: string,
    filePath: string | null,
    text: string,
    sectionLine: number | null,
    kanban: boolean,
  ) => Promise<void>;
  moveItem: (
    repoPath: string,
    filePath: string,
    line: number,
    expectedText: string,
    targetSectionLine: number,
    setChecked: boolean | null,
  ) => Promise<void>;
  removeProject: (repoPath: string) => void;
}

function todoFilesEqual(a: TodoFile[] | undefined, b: TodoFile[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].path !== b[i].path || a[i].items.length !== b[i].items.length) return false;
    if (a[i].sections.length !== b[i].sections.length) return false;
    for (let j = 0; j < a[i].sections.length; j++) {
      const x = a[i].sections[j];
      const y = b[i].sections[j];
      if (x.line !== y.line || x.title !== y.title || x.level !== y.level) return false;
    }
    for (let j = 0; j < a[i].items.length; j++) {
      const x = a[i].items[j];
      const y = b[i].items[j];
      if (x.line !== y.line || x.text !== y.text || x.checked !== y.checked) return false;
      if (x.sectionLine !== y.sectionLine) return false;
    }
  }
  return true;
}

export const useTodoStore = create<TodoStore>((set, get) => ({
  projectTodos: {},

  refreshTodos: async (repoPath: string) => {
    try {
      const files = await readTodos(repoPath);
      set((state) =>
        todoFilesEqual(state.projectTodos[repoPath], files)
          ? state
          : { projectTodos: { ...state.projectTodos, [repoPath]: files } },
      );
    } catch {
      // Repo may have been removed from disk — leave the cache untouched
    }
  },

  refreshAll: async (repoPaths: string[]) => {
    const results = await Promise.allSettled(repoPaths.map((p) => readTodos(p)));

    set((state) => {
      let changed = false;
      const nextTodos = { ...state.projectTodos };

      for (let i = 0; i < repoPaths.length; i++) {
        const result = results[i];
        if (result.status === "fulfilled" && !todoFilesEqual(state.projectTodos[repoPaths[i]], result.value)) {
          nextTodos[repoPaths[i]] = result.value;
          changed = true;
        }
      }

      return changed ? { projectTodos: nextTodos } : state;
    });
  },

  toggleItem: async (repoPath, filePath, line, expectedText, checked) => {
    try {
      await toggleTodo(filePath, line, expectedText, checked);
    } finally {
      // Reload even on failure — a mismatch error means the file changed
      // under us and the UI should catch up.
      await get().refreshTodos(repoPath);
    }
  },

  addItem: async (repoPath, filePath, text, sectionLine, kanban) => {
    await addTodo(repoPath, filePath, text, sectionLine, kanban);
    await get().refreshTodos(repoPath);
  },

  moveItem: async (repoPath, filePath, line, expectedText, targetSectionLine, setChecked) => {
    try {
      await moveTodo(filePath, line, expectedText, targetSectionLine, setChecked);
    } finally {
      await get().refreshTodos(repoPath);
    }
  },

  removeProject: (repoPath: string) => {
    set((state) => {
      const { [repoPath]: _, ...rest } = state.projectTodos;
      return { projectTodos: rest };
    });
  },
}));
