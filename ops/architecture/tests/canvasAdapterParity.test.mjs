import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { createServer } from "vite";

let vite;
let createLegacyWorkspaceProjection;
let legacyWorkspaceAction;
let createLaymanWorkspaceState;
let createLaymanCanvasController;
let laymanWorkspaceAction;
let parseUiWorkspaceDocument;

function propertyParameters() {
  const configured = process.env.SHIPCTL_PROPERTY_SEED;
  if (configured === undefined) return {};
  const seed = Number(configured);
  if (!Number.isSafeInteger(seed)) throw new Error("SHIPCTL_PROPERTY_SEED must be a safe integer");
  return { seed };
}

before(async () => {
  vite = await createServer({
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
    appType: "custom",
  });
  ({ createLegacyWorkspaceProjection, legacyWorkspaceAction } = await vite.ssrLoadModule(
    "/core/frontend/canvas/legacy/workspaceProjection.ts",
  ));
  ({ createLaymanWorkspaceState } = await vite.ssrLoadModule(
    "/core/frontend/canvas/layman/workspaceProjection.ts",
  ));
  ({ createLaymanCanvasController } = await vite.ssrLoadModule(
    "/core/frontend/canvas/layman/LaymanCanvas.tsx",
  ));
  ({ laymanWorkspaceAction } = await vite.ssrLoadModule(
    "/core/frontend/canvas/layman/workspaceActions.ts",
  ));
  ({ parseUiWorkspaceDocument } = await vite.ssrLoadModule(
    "/core/frontend/workspace/index.ts",
  ));
});

after(async () => {
  await vite?.close();
});

/**
 * The legacy adapter has one representable shape: one root tab stack, no
 * floating stack, and no maximized stack. This generator is intentionally
 * limited to that declared shared subset. Split and floating behavior remains
 * a separate Phase G closure item rather than false renderer parity.
 */
const sharedStackDocument = fc.array(
  fc.record({
    missing: fc.boolean(),
    closeable: fc.boolean(),
  }),
  { minLength: 1 },
).chain((views) => fc.integer({ min: 0, max: views.length - 1 }).map((selectedIndex) => ({
  views,
  selectedIndex,
})));

function projectionFrom({ views, selectedIndex }) {
  const rawDocument = {
    schemaVersion: 1,
    workspaceId: "shipctl.property.workspace",
    profileId: "shipctl.property.shared-stack",
    instances: views.map((view, index) => ({
      instanceId: `instance-${index}`,
      viewTypeId: `shipctl.fixture.view-${index}`,
      ownerModuleId: "shipctl.fixture",
      ownerActivationId: "shipctl.fixture@1#canvas",
      resource: { kind: "global" },
      label: `View ${index}`,
      stateRef: null,
      availability: view.missing
        ? {
            kind: "missing-definition",
            lastKnownViewTypeId: `shipctl.fixture.view-${index}`,
            catalogRevision: 2,
          }
        : { kind: "available" },
      lifecycle: "placed",
    })),
    root: {
      kind: "stack",
      stackId: "shipctl.property.primary",
      instanceIds: views.map((_view, index) => `instance-${index}`),
      selectedInstanceId: `instance-${selectedIndex}`,
    },
    floating: [],
    maximizedStackId: null,
  };
  const document = parseUiWorkspaceDocument(rawDocument);
  return {
    workspaceId: document.workspaceId,
    revision: 1,
    catalogRevision: 2,
    document,
    views: document.instances.map((instance, index) => ({
      instance,
      definition: null,
      title: instance.label ?? instance.viewTypeId,
      closeable: views[index].closeable,
      splitAllowed: true,
    })),
  };
}

function normalizeLegacy(projection) {
  assert.equal(projection.kind, "stack");
  return {
    viewIds: [...projection.viewIds],
    activeViewId: projection.activeViewId,
  };
}

function normalizeLayman(state) {
  assert.ok(state.layout, "a shared root stack produces one Layman window");
  assert.ok("tabs" in state.layout, "a shared root stack is a Layman tab window");
  return {
    viewIds: state.layout.tabs.map((tab) => tab.id),
    activeViewId: state.layout.selectedTabId,
  };
}

function laymanAction(projection, command) {
  const controller = createLaymanCanvasController(createLaymanWorkspaceState(projection));
  const transition = controller.dispatch(command, { origin: "user" });
  return {
    action: laymanWorkspaceAction(transition),
    state: controller.getState(),
  };
}

test("architecture.canvas-adapter-parity.property", () => {
  fc.assert(fc.property(sharedStackDocument, (fixture) => {
    const projection = projectionFrom(fixture);
    const legacy = createLegacyWorkspaceProjection(projection);
    const layman = createLaymanWorkspaceState(projection);

    assert.deepEqual(normalizeLegacy(legacy), normalizeLayman(layman));

    for (const instanceId of normalizeLegacy(legacy).viewIds) {
      const legacySelect = legacyWorkspaceAction(legacy, { kind: "select", instanceId });
      const laymanSelect = laymanAction(projection, { type: "tab.select", tabId: instanceId });
      assert.deepEqual(laymanSelect.action, legacySelect);
      assert.equal(normalizeLayman(laymanSelect.state).activeViewId, instanceId);

      const legacyClose = legacyWorkspaceAction(legacy, { kind: "close", instanceId });
      const laymanClose = laymanAction(projection, { type: "tab.remove", tabId: instanceId });
      assert.deepEqual(laymanClose.action, legacyClose);
    }
  }), propertyParameters());
});
