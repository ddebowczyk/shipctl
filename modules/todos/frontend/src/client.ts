import { invoke } from "@tauri-apps/api/core";

import type { TodoFile } from "./types";

export function readTodos(repoPath: string): Promise<TodoFile[]> {
  return invoke("read_todos", { repoPath });
}

export function toggleTodo(
  filePath: string,
  line: number,
  expectedText: string,
  checked: boolean,
): Promise<void> {
  return invoke("toggle_todo", { filePath, line, expectedText, checked });
}

export function addTodo(
  repoPath: string,
  filePath: string | null,
  text: string,
  sectionLine: number | null,
  kanban: boolean,
): Promise<void> {
  return invoke("add_todo", { repoPath, filePath, text, sectionLine, kanban });
}

export function moveTodo(
  filePath: string,
  line: number,
  expectedText: string,
  targetSectionLine: number,
  setChecked: boolean | null,
): Promise<void> {
  return invoke("move_todo", {
    filePath,
    line,
    expectedText,
    targetSectionLine,
    setChecked,
  });
}
