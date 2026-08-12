import type { ShipctlModule } from "@shipctl/module-api";
import { assistantsModule } from "@shipctl/module-assistants";
import { commandsModule } from "@shipctl/module-commands";
import { gitModule } from "@shipctl/module-git";
import { portsModule } from "@shipctl/module-ports";
import { semanticTerminalModule } from "@shipctl/module-semantic-terminal";
import { skillsModule } from "@shipctl/module-skills";
import { thinTerminalModule } from "@shipctl/module-thin-terminal";
import { todosModule } from "@shipctl/module-todos";
import { usageModule } from "@shipctl/module-usage";

/**
 * Compile-time frontend module profile. Optional modules are imported here,
 * through their public package entrypoints, and nowhere else in host code.
 */
export const ENABLED_MODULES = [
  ...(import.meta.env.VITE_SHIPCTL_USAGE_MODULE === "disabled" ? [] : [usageModule]),
  ...(import.meta.env.VITE_SHIPCTL_ASSISTANTS_MODULE === "disabled" ? [] : [assistantsModule]),
  portsModule,
  ...(import.meta.env.VITE_SHIPCTL_COMMANDS_MODULE === "disabled" ? [] : [commandsModule]),
  todosModule,
  skillsModule,
  semanticTerminalModule,
  thinTerminalModule,
  ...(import.meta.env.VITE_SHIPCTL_GIT_MODULE === "disabled" ? [] : [gitModule]),
] as const satisfies readonly ShipctlModule[];
