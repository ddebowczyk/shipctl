import { create } from "zustand";

import type { GitClient } from "./gitClient";
import type { GitStatus } from "./types";

interface GitStore {
  projectGitStatus: Record<string, GitStatus>;
  refreshStatus: (repoPath: string, client: GitClient) => Promise<void>;
  refreshAll: (repoPaths: readonly string[], client: GitClient) => Promise<void>;
  removeProject: (repoPath: string) => void;
}

function statusChanged(previous: GitStatus | undefined, next: GitStatus): boolean {
  return !previous
    || previous.isRepository !== next.isRepository
    || previous.branchName !== next.branchName
    || previous.dirty !== next.dirty
    || previous.stagedCount !== next.stagedCount
    || previous.unstagedCount !== next.unstagedCount
    || previous.untrackedCount !== next.untrackedCount
    || previous.aheadCount !== next.aheadCount
    || previous.behindCount !== next.behindCount
    || previous.worktreeParentProjectId !== next.worktreeParentProjectId;
}

export const useGitStore = create<GitStore>((set) => ({
  projectGitStatus: {},

  refreshStatus: async (repoPath, client) => {
    try {
      const status = await client.status(repoPath);
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

  refreshAll: async (repoPaths, client) => {
    const results = await Promise.allSettled(repoPaths.map((path) => client.status(path)));
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
