import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  terminalDriverId,
  type ModuleActivationContext,
  type ModuleActivationId,
  type ModuleId,
  type PluginRuntimeInspection,
  type ShipctlModule,
} from "@shipctl/module-api";
import type { RuntimeModuleDescriptor } from "@shipctl/core/runtime";
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

test("host snapshot projects direct artifact registrations without a legacy module object", () => {
  const moduleId = "fixture.post-package-deployment" as ModuleId;
  const activationId = "fixture.post-package-deployment@1.0.0#digest" as ModuleActivationId;
  const descriptor: RuntimeModuleDescriptor = {
    schemaVersion: 1,
    moduleId,
    version: "1.0.0",
    contentDigest: "a".repeat(64),
    entryPath: "/runtime/fixture/post-package-deployment/index.js",
    stylePaths: [],
    manifest: {
      schemaVersion: 2,
      application: {},
      lifecycle: "live",
      messages: {},
      requestedGrants: [],
    },
    capabilities: { definitions: [] },
  };
  const activation = {
    identity: { moduleId, activationId },
  } as ModuleActivationContext;
  const inspection: PluginRuntimeInspection = {
    activations: [{
      moduleId,
      activationId,
      role: "presentation",
      status: "active",
    }],
    contributions: [{
      ownerActivationId: activationId,
      moduleId,
      family: "command",
      id: "fixture.post-package-deployment.command",
    }],
    effects: [],
    services: [],
  };

  assert.deepEqual(buildFrontendRuntimeSnapshot({
    registryRevision: 21,
    activationContextsByModule: new Map([[moduleId, activation]]),
    artifactDescriptorsByModule: new Map([[moduleId, descriptor]]),
    inspection,
  }), {
    schemaVersion: 1,
    registryRevision: 21,
    modules: [{
      moduleId,
      artifactContentDigest: descriptor.contentDigest,
      activationId,
      contributions: [{
        id: "fixture.post-package-deployment.command",
        kind: "command",
      }],
    }],
    activationOutcomes: [],
  });
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
