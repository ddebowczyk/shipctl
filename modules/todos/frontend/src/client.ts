import { invoke } from "@tauri-apps/api/core";

import type { TodoFile } from "./types";

export const TODO_COMMANDS = {
  read: "plugin:shep-todos|read_todos",
  toggle: "plugin:shep-todos|toggle_todo",
  add: "plugin:shep-todos|add_todo",
  move: "plugin:shep-todos|move_todo",
} as const;

export function readTodos(repoPath: string): Promise<TodoFile[]> {
  return invoke(TODO_COMMANDS.read, { repoPath });
}

export function toggleTodo(
  filePath: string,
  line: number,
  expectedText: string,
  checked: boolean,
): Promise<void> {
  return invoke(TODO_COMMANDS.toggle, { filePath, line, expectedText, checked });
}

export function addTodo(
  repoPath: string,
  filePath: string | null,
  text: string,
  sectionLine: number | null,
  kanban: boolean,
): Promise<void> {
  return invoke(TODO_COMMANDS.add, { repoPath, filePath, text, sectionLine, kanban });
}

export function moveTodo(
  filePath: string,
  line: number,
  expectedText: string,
  targetSectionLine: number,
  setChecked: boolean | null,
): Promise<void> {
  return invoke(TODO_COMMANDS.move, {
    filePath,
    line,
    expectedText,
    targetSectionLine,
    setChecked,
  });
}
