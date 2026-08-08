import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { ShipctlModule } from "@shipctl/module-api";
import { createServer, type ViteDevServer } from "vite";

type RuntimeSnapshotModule = typeof import("../moduleRuntimeSnapshot.ts");

let vite: ViteDevServer;
let buildFrontendRuntimeSnapshot: RuntimeSnapshotModule["buildFrontendRuntimeSnapshot"];

before(async () => {
  vite = await createServer({ server: { middlewareMode: true }, appType: "custom" });
  ({ buildFrontendRuntimeSnapshot } = await vite.ssrLoadModule(
    "/core/frontend/host/moduleRuntimeSnapshot.ts",
  ) as RuntimeSnapshotModule);
});

after(async () => {
  await vite.close();
});

const module: ShipctlModule = {
  id: "shipctl.fixture",
  version: "1.0.0",
  panels: [{
    id: "fixture.panel",
    moduleId: "shipctl.fixture",
    scope: "global",
    label: "Fixture",
    icon: { name: "terminal" },
    singleton: "global",
    load: async () => ({ default: () => null }),
  }],
  scheduledTasks: [{
    id: "fixture.refresh",
    moduleId: "shipctl.fixture",
    schedule: { kind: "startup" },
    run: () => undefined,
  }],
};

test("host snapshot contains only module identity and declared contribution facts", () => {
  assert.deepEqual(buildFrontendRuntimeSnapshot([module]), {
    schemaVersion: 1,
    modules: [{
      moduleId: "shipctl.fixture",
      contributions: [
        { id: "fixture.panel", kind: "panel" },
        { id: "fixture.refresh", kind: "scheduled_task" },
      ],
    }],
  });
});

test("default snapshot reports the actual compiled frontend profile", () => {
  const snapshot = buildFrontendRuntimeSnapshot();
  assert(snapshot.modules.length > 0);
  assert(snapshot.modules.every((entry) => entry.moduleId.startsWith("shipctl.")));
  assert(snapshot.modules.some((entry) => entry.contributions.length > 0));
});

test("host snapshot rejects a contribution claiming another module owner", () => {
  assert.throws(
    () => buildFrontendRuntimeSnapshot([{
      ...module,
      panels: [{ ...module.panels![0], moduleId: "shipctl.other" }],
    }]),
    /belongs to shipctl\.other, not shipctl\.fixture/,
  );
});
