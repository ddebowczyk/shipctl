import type { ShepModule } from "@shep/module-api";

export { FIXTURE_PING_COMMAND, pingFixture } from "./client";

export const fixtureModule = {
  id: "shep.fixture",
  version: "0.0.0",
  panels: [
    {
      id: "fixture.panel",
      moduleId: "shep.fixture",
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
} as const satisfies ShepModule;
