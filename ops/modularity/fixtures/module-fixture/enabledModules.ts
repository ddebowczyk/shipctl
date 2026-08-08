import type { ShipctlModule } from "@shipctl/module-api";
import { fixtureModule } from "@shipctl/module-fixture";

export const ENABLED_MODULES = [fixtureModule] as const satisfies readonly ShipctlModule[];
