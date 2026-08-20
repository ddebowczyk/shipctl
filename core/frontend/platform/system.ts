import { invoke } from "@tauri-apps/api/core";

import type { PreferredEditor } from "@shipctl/core/configuration";

/** Generic host-environment and operating-system handoff port. */
export function openInEditor(
  repoPath: string,
  editorId: PreferredEditor,
): Promise<void> {
  return invoke("open_in_editor", {
    repoPath,
    editorId,
  });
}

export function revealInFinder(path: string): Promise<void> {
  return invoke("reveal_in_finder", { path });
}

export function openUrl(url: string, allowedSchemes: readonly string[]): Promise<void> {
  return invoke("open_url", { url, allowedSchemes: [...allowedSchemes] });
}

export function getUsername(): Promise<string> {
  return invoke("get_username");
}

export function getHomeDirectory(): Promise<string> {
  return invoke("get_home_directory");
}

export function getDefaultShell(): Promise<string> {
  return invoke("get_default_shell");
}

export function getComputerName(): Promise<string> {
  return invoke("get_computer_name");
}

export function checkCommandExists(command: string): Promise<boolean> {
  return invoke("check_command_exists", { command });
}

export interface MemoryStats {
  readonly app_rss: number;
  readonly children_rss: number;
}

export function getMemoryStats(): Promise<MemoryStats> {
  return invoke("get_memory_stats");
}
