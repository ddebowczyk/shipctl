import { create } from "zustand";
import type { SkillInfo } from "../lib/types";
import { listSkills, setupSkill, removeSkill } from "../lib/tauri";

interface SkillStore {
  /** Built-in agent skills with install state, per repo. The files on disk
   *  (.agents/skills/) are the source of truth — this is only a render cache. */
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
      // Repo may have been removed from disk — leave the cache untouched
    }
  },

  refreshAll: async (repoPaths) => {
    const results = await Promise.allSettled(repoPaths.map((p) => listSkills(p)));
    set((state) => {
      let changed = false;
      const next = { ...state.skillsByRepo };
      for (let i = 0; i < repoPaths.length; i++) {
        const result = results[i];
        if (result.status === "fulfilled" && !skillsEqual(state.skillsByRepo[repoPaths[i]], result.value)) {
          next[repoPaths[i]] = result.value;
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
      const { [repoPath]: _, ...rest } = state.skillsByRepo;
      return { skillsByRepo: rest };
    });
  },
}));
