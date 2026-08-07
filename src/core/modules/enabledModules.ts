import type { ShepModule } from "@shep/module-api";
import { gitFrontendCompatibility, gitModule } from "@shep/module-git";
import { portsModule } from "@shep/module-ports";
import { skillsModule } from "@shep/module-skills";
import { todosModule } from "@shep/module-todos";

/**
 * Compile-time frontend module profile. Optional modules are imported here,
 * through their public package entrypoints, and nowhere else in host code.
 */
export const ENABLED_MODULES = [
  portsModule,
  todosModule,
  skillsModule,
  ...(import.meta.env.VITE_SHEP_GIT_MODULE === "disabled" ? [] : [gitModule]),
] as const satisfies readonly ShepModule[];

/** Temporary bridge for Git visuals that have not moved into the module yet. */
export const ENABLED_GIT_FRONTEND = gitFrontendCompatibility;
export type {
  ChangedFile,
  CreatedWorktree,
  DiffFileStat,
  GitStatus,
  ProjectPanelState,
  WorktreeEntry,
} from "@shep/module-git";
