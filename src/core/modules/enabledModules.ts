import type { ShepModule } from "@shep/module-api";
import { assistantsModule } from "@shep/module-assistants";
import { commandsModule } from "@shep/module-commands";
import { gitModule } from "@shep/module-git";
import { portsModule } from "@shep/module-ports";
import { skillsModule } from "@shep/module-skills";
import { todosModule } from "@shep/module-todos";
import { usageModule } from "@shep/module-usage";

/**
 * Compile-time frontend module profile. Optional modules are imported here,
 * through their public package entrypoints, and nowhere else in host code.
 */
export const ENABLED_MODULES = [
  ...(import.meta.env.VITE_SHEP_USAGE_MODULE === "disabled" ? [] : [usageModule]),
  ...(import.meta.env.VITE_SHEP_ASSISTANTS_MODULE === "disabled" ? [] : [assistantsModule]),
  portsModule,
  ...(import.meta.env.VITE_SHEP_COMMANDS_MODULE === "disabled" ? [] : [commandsModule]),
  todosModule,
  skillsModule,
  ...(import.meta.env.VITE_SHEP_GIT_MODULE === "disabled" ? [] : [gitModule]),
] as const satisfies readonly ShepModule[];
