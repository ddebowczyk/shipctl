import type { ShepModule } from "@shep/module-api";
import { fixtureModule } from "@shep/module-fixture";

export const ENABLED_MODULES = [fixtureModule] as const satisfies readonly ShepModule[];
