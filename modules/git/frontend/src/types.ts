export interface GitStatus {
  is_git_repo: boolean;
  branch: string;
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  ahead: number;
  behind: number;
  worktree_parent: string | null;
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  is_main: boolean;
}

export interface CreatedWorktree {
  path: string;
  branch: string;
}

export interface DiffFileStat {
  path: string;
  additions: number;
  deletions: number;
}

export interface ChangedFile {
  path: string;
  status: string;
  area: string;
  old_path: string | null;
}
