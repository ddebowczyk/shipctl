import { invoke } from "@tauri-apps/api/core";

import type { SkillInfo } from "./types";

export const SKILL_COMMANDS = {
  list: "plugin:shep-skills|list_skills",
  setup: "plugin:shep-skills|setup_skill",
  remove: "plugin:shep-skills|remove_skill",
} as const;

export function listSkills(repoPath: string): Promise<SkillInfo[]> {
  return invoke(SKILL_COMMANDS.list, { repoPath });
}

export function setupSkill(repoPath: string, name: string): Promise<void> {
  return invoke(SKILL_COMMANDS.setup, { repoPath, name });
}

export function removeSkill(repoPath: string, name: string): Promise<void> {
  return invoke(SKILL_COMMANDS.remove, { repoPath, name });
}
