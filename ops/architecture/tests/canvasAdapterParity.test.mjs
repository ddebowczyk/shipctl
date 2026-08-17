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
const generatedView = fc.record({
  missing: fc.boolean(),
  closeable: fc.boolean(),
});

const sharedStackDocument = fc.array(
  generatedView,
  { minLength: 1 },
).chain((views) => fc.integer({ min: 0, max: views.length - 1 }).map((selectedIndex) => ({
  views,
  selectedIndex,
})));

const tiledMoveDocument = fc.tuple(
  fc.array(generatedView, { minLength: 1 }),
  fc.array(generatedView, { minLength: 1 }),
).chain(([leftViews, rightViews]) => fc.integer({
  min: 0,
  max: leftViews.length - 1,
}).map((sourceIndex) => ({ leftViews, rightViews, sourceIndex })));

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

function tiledMoveProjection({ leftViews, rightViews }) {
  const entries = [
    ...leftViews.map((view, index) => ({ ...view, instanceId: `left-${index}` })),
    ...rightViews.map((view, index) => ({ ...view, instanceId: `right-${index}` })),
  ];
  const rawDocument = {
    schemaVersion: 1,
    workspaceId: "shipctl.property.workspace",
    profileId: "shipctl.property.tiled-move",
    instances: entries.map((view) => ({
      instanceId: view.instanceId,
      viewTypeId: `shipctl.fixture.${view.instanceId}`,
      ownerModuleId: "shipctl.fixture",
      ownerActivationId: "shipctl.fixture@1#canvas",
      resource: { kind: "global" },
      label: view.instanceId,
      stateRef: null,
      availability: view.missing
        ? {
            kind: "missing-definition",
            lastKnownViewTypeId: `shipctl.fixture.${view.instanceId}`,
            catalogRevision: 2,
          }
        : { kind: "available" },
      lifecycle: "placed",
    })),
    root: {
      kind: "split",
      nodeId: "shipctl.property.root",
      axis: "horizontal",
      firstShare: 0.5,
      first: {
        kind: "stack",
        stackId: "left",
        instanceIds: leftViews.map((_view, index) => `left-${index}`),
        selectedInstanceId: "left-0",
      },
      second: {
        kind: "stack",
        stackId: "right",
        instanceIds: rightViews.map((_view, index) => `right-${index}`),
        selectedInstanceId: "right-0",
      },
    },
    floating: [],
    maximizedStackId: null,
  };
  const document = parseUiWorkspaceDocument(rawDocument);
  const viewByInstanceId = new Map(entries.map((view) => [view.instanceId, view]));
  return {
    workspaceId: document.workspaceId,
    revision: 1,
    catalogRevision: 2,
    document,
    views: document.instances.map((instance) => {
      const view = viewByInstanceId.get(instance.instanceId);
      assert.ok(view, `missing generated view ${instance.instanceId}`);
      return {
        instance,
        definition: null,
        title: instance.label ?? instance.viewTypeId,
        closeable: view.closeable,
        splitAllowed: true,
      };
    }),
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

test("architecture.layman-semantic-move.property", () => {
  fc.assert(fc.property(tiledMoveDocument, (fixture) => {
    const projection = tiledMoveProjection(fixture);
    const instanceId = `left-${fixture.sourceIndex}`;
    const targetWindowId = "shipctl.workspace.stack:right";
    const controller = createLaymanCanvasController(createLaymanWorkspaceState(projection));
    const transition = controller.dispatch({
      type: "tab.move",
      tabId: instanceId,
      target: { kind: "window", windowId: targetWindowId },
      placement: "center",
    }, { origin: "user" });

    assert.equal(transition.status, "applied");
    assert.deepEqual(laymanWorkspaceAction(transition), {
      kind: "move",
      instanceId,
      targetStackId: "right",
      position: "end",
      relativeInstanceId: null,
    });

    const inspection = controller.inspect();
    const sourceWindow = inspection.windows.find((window) => (
      window.id === "shipctl.workspace.stack:left"
    ));
    const targetWindow = inspection.windows.find((window) => window.id === targetWindowId);
    const expectedSource = fixture.leftViews
      .map((_view, index) => `left-${index}`)
      .filter((candidate) => candidate !== instanceId);
    const expectedTarget = [
      ...fixture.rightViews.map((_view, index) => `right-${index}`),
      instanceId,
    ];

    if (expectedSource.length === 0) {
      assert.equal(sourceWindow, undefined);
    } else {
      assert.deepEqual(sourceWindow?.tabs.map((tab) => tab.id), expectedSource);
    }
    assert.deepEqual(targetWindow?.tabs.map((tab) => tab.id), expectedTarget);
  }), propertyParameters());
});
