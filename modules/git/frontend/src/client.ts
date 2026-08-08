import { invoke } from "@tauri-apps/api/core";

import type {
  ChangedFile,
  CreatedWorktree,
  DiffFileStat,
  GitStatus,
  WorktreeEntry,
} from "./types";

export const GIT_COMMANDS = {
  isRepo: "plugin:shipctl-git|is_git_repo",
  init: "plugin:shipctl-git|git_init",
  currentBranch: "plugin:shipctl-git|git_current_branch",
  listBranches: "plugin:shipctl-git|git_list_branches",
  listWorktrees: "plugin:shipctl-git|git_list_worktrees",
  createWorktree: "plugin:shipctl-git|git_create_worktree",
  status: "plugin:shipctl-git|git_status",
  changedFiles: "plugin:shipctl-git|git_changed_files",
  fileDiff: "plugin:shipctl-git|git_file_diff",
  fileContents: "plugin:shipctl-git|git_file_contents",
  listFiles: "plugin:shipctl-git|git_list_files",
  switchBranch: "plugin:shipctl-git|git_switch_branch",
  createBranch: "plugin:shipctl-git|git_create_branch",
  diffStats: "plugin:shipctl-git|git_diff_stats",
} as const;

export function isGitRepo(path: string): Promise<boolean> {
  return invoke(GIT_COMMANDS.isRepo, { path });
}

export function gitInit(path: string): Promise<void> {
  return invoke(GIT_COMMANDS.init, { path });
}

export function gitCurrentBranch(path: string): Promise<string> {
  return invoke(GIT_COMMANDS.currentBranch, { path });
}

export function gitListBranches(path: string): Promise<string[]> {
  return invoke(GIT_COMMANDS.listBranches, { path });
}

export function gitListWorktrees(path: string): Promise<WorktreeEntry[]> {
  return invoke(GIT_COMMANDS.listWorktrees, { path });
}

export function gitCreateWorktree(path: string, branchName: string): Promise<CreatedWorktree> {
  return invoke(GIT_COMMANDS.createWorktree, { path, branchName });
}

export function gitStatus(path: string): Promise<GitStatus> {
  return invoke(GIT_COMMANDS.status, { path });
}

export function gitChangedFiles(path: string): Promise<ChangedFile[]> {
  return invoke(GIT_COMMANDS.changedFiles, { path });
}

export function gitFileDiff(path: string, filePath: string, staged: boolean): Promise<string> {
  return invoke(GIT_COMMANDS.fileDiff, { path, filePath, staged });
}

export function gitFileContents(
  path: string,
  filePath: string,
  source: "working" | "staged" | "head",
): Promise<string> {
  return invoke(GIT_COMMANDS.fileContents, { path, filePath, source });
}

export function gitListFiles(path: string): Promise<string[]> {
  return invoke(GIT_COMMANDS.listFiles, { path });
}

export function gitSwitchBranch(path: string, branchName: string): Promise<void> {
  return invoke(GIT_COMMANDS.switchBranch, { path, branchName });
}

export function gitCreateBranch(path: string, branchName: string): Promise<void> {
  return invoke(GIT_COMMANDS.createBranch, { path, branchName });
}

export function gitDiffStats(path: string): Promise<DiffFileStat[]> {
  return invoke(GIT_COMMANDS.diffStats, { path });
}
