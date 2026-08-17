import type { ShipctlModule } from "@shipctl/module-api";

/**
 * Compile-time frontend module profile. Feature modules are delivered through
 * admitted runtime artifacts; only irreducible host modules belong here.
 */
export const ENABLED_MODULES = [] as const satisfies readonly ShipctlModule[];
