import { create } from "zustand";

import { listSkills, removeSkill, setupSkill } from "./client";
import type { SkillInfo } from "./types";

interface SkillStore {
  /** Built-in agent skills with install state, per repo. The files on disk
   *  (`.agents/skills/`) are the source of truth; this is a render cache. */
  skillsByRepo: Record<string, SkillInfo[]>;
  refresh: (repoPath: string) => Promise<void>;
  refreshAll: (repoPaths: string[]) => Promise<void>;
  install: (repoPath: string, name: string) => Promise<void>;
  uninstall: (repoPath: string, name: string) => Promise<void>;
  removeProject: (repoPath: string) => void;
}

function skillsEqual(a: SkillInfo[] | undefined, b: SkillInfo[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name || a[i].installed !== b[i].installed) return false;
  }
  return true;
}

export const useSkillStore = create<SkillStore>((set, get) => ({
  skillsByRepo: {},

  refresh: async (repoPath) => {
    try {
      const skills = await listSkills(repoPath);
      set((state) =>
        skillsEqual(state.skillsByRepo[repoPath], skills)
          ? state
          : { skillsByRepo: { ...state.skillsByRepo, [repoPath]: skills } },
      );
    } catch {
      // Repo may have been removed from disk; leave the cache untouched.
    }
  },

  refreshAll: async (repoPaths) => {
    const results = await Promise.allSettled(repoPaths.map((path) => listSkills(path)));
    set((state) => {
      let changed = false;
      const next = { ...state.skillsByRepo };
      for (let index = 0; index < repoPaths.length; index++) {
        const result = results[index];
        if (
          result.status === "fulfilled"
          && !skillsEqual(state.skillsByRepo[repoPaths[index]], result.value)
        ) {
          next[repoPaths[index]] = result.value;
          changed = true;
        }
      }
      return changed ? { skillsByRepo: next } : state;
    });
  },

  install: async (repoPath, name) => {
    await setupSkill(repoPath, name);
    await get().refresh(repoPath);
  },

  uninstall: async (repoPath, name) => {
    await removeSkill(repoPath, name);
    await get().refresh(repoPath);
  },

  removeProject: (repoPath) => {
    set((state) => {
      const { [repoPath]: _removed, ...rest } = state.skillsByRepo;
      return { skillsByRepo: rest };
    });
  },
}));
