import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { terminalDriverId, type ShipctlModule } from "@shipctl/module-api";
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
  terminalPresentations: [{
    moduleId: "shipctl.fixture",
    driverId: terminalDriverId("fixture-terminal"),
    Presentation: () => null,
  }],
};

test("host snapshot contains only module identity and declared contribution facts", () => {
  assert.deepEqual(buildFrontendRuntimeSnapshot({ registryRevision: 7 }, [module]), {
    schemaVersion: 1,
    registryRevision: 7,
    modules: [{
      moduleId: "shipctl.fixture",
      contributions: [
        { id: "fixture.panel", kind: "panel" },
        { id: "fixture.refresh", kind: "scheduled_task" },
        { id: "fixture-terminal", kind: "terminal_presentation" },
      ],
    }],
    activationOutcomes: [],
  });
});

test("default snapshot excludes runtime artifacts until they are admitted", () => {
  const snapshot = buildFrontendRuntimeSnapshot({ registryRevision: 0 });
  assert.deepEqual(snapshot.modules, []);
});

test("host snapshot exposes declarative message contributions", () => {
  const message = { id: "fixture.value", version: 1 } as const;
  const withMessages: ShipctlModule = {
    id: "shipctl.messages",
    version: "1.0.0",
    messages: {
      handles: [{
        channel: { id: "fixture.directed", message },
        capacity: 1,
        requiredGrant: "message.send.fixture.directed",
        schedulerAllowed: false,
        handle: () => undefined,
      }],
      subscribes: [{
        topic: { id: "fixture.events", message },
        handle: () => undefined,
      }],
    },
  };
  assert.deepEqual(
    buildFrontendRuntimeSnapshot({ registryRevision: 0 }, [withMessages]).modules[0]?.contributions,
    [
      { id: "fixture.directed", kind: "message_handler" },
      { id: "fixture.events", kind: "message_subscription" },
    ],
  );
});

test("host snapshot rejects a contribution claiming another module owner", () => {
  assert.throws(
    () => buildFrontendRuntimeSnapshot(
      { registryRevision: 0 },
      [{
        ...module,
        panels: [{ ...module.panels![0], moduleId: "shipctl.other" }],
      }],
    ),
    /belongs to shipctl\.other, not shipctl\.fixture/,
  );
});

test("host snapshot rejects a terminal presentation claiming another module owner", () => {
  assert.throws(
    () => buildFrontendRuntimeSnapshot(
      { registryRevision: 0 },
      [{
        ...module,
        terminalPresentations: [{
          ...module.terminalPresentations![0],
          moduleId: "shipctl.other",
        }],
      }],
    ),
    /belongs to shipctl\.other, not shipctl\.fixture/,
  );
});
