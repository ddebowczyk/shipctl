import { create } from "zustand";

import { gitStatus } from "./client";
import type { GitStatus } from "./types";

interface GitStore {
  projectGitStatus: Record<string, GitStatus>;
  refreshStatus: (repoPath: string) => Promise<void>;
  refreshAll: (repoPaths: readonly string[]) => Promise<void>;
  removeProject: (repoPath: string) => void;
}

function statusChanged(previous: GitStatus | undefined, next: GitStatus): boolean {
  return !previous
    || previous.is_git_repo !== next.is_git_repo
    || previous.branch !== next.branch
    || previous.dirty !== next.dirty
    || previous.staged !== next.staged
    || previous.unstaged !== next.unstaged
    || previous.untracked !== next.untracked
    || previous.ahead !== next.ahead
    || previous.behind !== next.behind
    || previous.worktree_parent !== next.worktree_parent;
}

export const useGitStore = create<GitStore>((set) => ({
  projectGitStatus: {},

  refreshStatus: async (repoPath) => {
    try {
      const status = await gitStatus(repoPath);
      set((state) => {
        const previous = state.projectGitStatus[repoPath];
        if (!statusChanged(previous, status)) return state;
        return {
          projectGitStatus: { ...state.projectGitStatus, [repoPath]: status },
        };
      });
    } catch {
      // Git metadata is optional and must not block project navigation.
    }
  },

  refreshAll: async (repoPaths) => {
    const results = await Promise.allSettled(repoPaths.map((path) => gitStatus(path)));
    set((state) => {
      const next = { ...state.projectGitStatus };
      let changed = false;
      for (let index = 0; index < repoPaths.length; index += 1) {
        const result = results[index];
        if (result.status !== "fulfilled") continue;
        const path = repoPaths[index];
        if (!statusChanged(state.projectGitStatus[path], result.value)) continue;
        next[path] = result.value;
        changed = true;
      }
      return changed ? { projectGitStatus: next } : state;
    });
  },

  removeProject: (repoPath) => {
    set((state) => {
      if (!(repoPath in state.projectGitStatus)) return state;
      const { [repoPath]: _removed, ...remaining } = state.projectGitStatus;
      return { projectGitStatus: remaining };
    });
  },
}));
