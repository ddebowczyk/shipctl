import type { ShepModule } from "@shep/module-api";
import { todosModule } from "@shep/module-todos";

/**
 * Compile-time frontend module profile. Optional modules are imported here,
 * through their public package entrypoints, and nowhere else in host code.
 */
export const ENABLED_MODULES = [todosModule] as const satisfies readonly ShepModule[];
