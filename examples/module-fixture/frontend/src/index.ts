import type { ShipctlModule } from "@shipctl/module-api";

export { FIXTURE_PING_COMMAND, pingFixture } from "./client";

export const fixtureModule = {
  id: "shipctl.fixture",
  version: "0.0.0",
  panels: [
    {
      id: "fixture.panel",
      moduleId: "shipctl.fixture",
      scope: "global",
      label: "Module Fixture",
      icon: { name: "flask-conical", label: "Fixture" },
      singleton: "global",
      order: 1_000,
      unavailable: {
        title: "Module fixture unavailable",
        description: "The internal fixture panel could not be loaded.",
      },
      load: () => import("./FixturePanel"),
    },
  ],
} as const satisfies ShipctlModule;
