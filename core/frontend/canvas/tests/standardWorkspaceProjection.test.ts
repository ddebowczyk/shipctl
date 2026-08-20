import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createServer, type ViteDevServer } from "vite";
import type { UiWorkspaceDocument, WorkspaceRevision } from "@shipctl/module-api";
import type { WorkspaceCanvasProjection } from "@shipctl/core/workspace";

type ProjectionModule = typeof import("../standard/workspaceProjection.ts");

let vite: ViteDevServer;
let createStandardWorkspaceProjection: ProjectionModule["createStandardWorkspaceProjection"];
let standardWorkspaceAction: ProjectionModule["standardWorkspaceAction"];

before(async () => {
  vite = await createServer({
    server: { hmr: false, middlewareMode: true },
    appType: "custom",
  });
  ({ createStandardWorkspaceProjection, standardWorkspaceAction } = await vite.ssrLoadModule(
    "/core/frontend/canvas/standard/workspaceProjection.ts",
  ) as ProjectionModule);
});

after(async () => {
  await vite.close();
});

function fixtureProjection(overrides: Partial<UiWorkspaceDocument> = {}): WorkspaceCanvasProjection {
  const document: UiWorkspaceDocument = {
    schemaVersion: 1,
    workspaceId: "fixture.workspace",
    profileId: "fixture.profile",
    instances: [
      {
        instanceId: "first",
        viewTypeId: "fixture.first",
        ownerModuleId: "shipctl.fixture",
        ownerActivationId: "shipctl.fixture@1#canvas",
        resource: { kind: "global" },
        label: "First",
        stateRef: null,
        availability: { kind: "available" },
        lifecycle: "placed",
      },
      {
        instanceId: "second",
        viewTypeId: "fixture.second",
        ownerModuleId: "shipctl.fixture",
        ownerActivationId: "shipctl.fixture@1#canvas",
        resource: { kind: "global" },
        label: "Second",
        stateRef: null,
        availability: {
          kind: "missing-definition",
          lastKnownViewTypeId: "fixture.second",
          catalogRevision: 3,
        },
        lifecycle: "placed",
      },
    ],
    root: {
      kind: "stack",
      stackId: "fixture.primary",
      instanceIds: ["first", "second"],
      selectedInstanceId: "second",
    },
    floating: [],
    maximizedStackId: null,
    ...overrides,
  };
  return {
    workspaceId: document.workspaceId,
    revision: 2 as WorkspaceRevision,
    catalogRevision: 3,
    document,
    views: [
      {
        instance: document.instances[0]!,
        definition: null,
        title: "First",
        closeable: false,
        splitAllowed: false,
      },
      {
        instance: document.instances[1]!,
        definition: null,
        title: "Second",
        closeable: true,
        splitAllowed: true,
      },
    ],
  };
}

test("standard projection keeps semantic tab order, active identity, and missing views", () => {
  const projection = createStandardWorkspaceProjection(fixtureProjection());

  assert.deepEqual(projection, {
    kind: "stack",
    stackId: "fixture.primary",
    viewIds: ["first", "second"],
    activeViewId: "second",
    views: [
      {
        instance: {
          instanceId: "first",
          viewTypeId: "fixture.first",
          ownerModuleId: "shipctl.fixture",
          ownerActivationId: "shipctl.fixture@1#canvas",
          resource: { kind: "global" },
          label: "First",
          stateRef: null,
          availability: { kind: "available" },
          lifecycle: "placed",
        },
        definition: null,
        title: "First",
        closeable: false,
        splitAllowed: false,
      },
      {
        instance: {
          instanceId: "second",
          viewTypeId: "fixture.second",
          ownerModuleId: "shipctl.fixture",
          ownerActivationId: "shipctl.fixture@1#canvas",
          resource: { kind: "global" },
          label: "Second",
          stateRef: null,
          availability: {
            kind: "missing-definition",
            lastKnownViewTypeId: "fixture.second",
            catalogRevision: 3,
          },
          lifecycle: "placed",
        },
        definition: null,
        title: "Second",
        closeable: true,
        splitAllowed: true,
      },
    ],
  });
});

test("standard projection exposes the same select and permitted close actions as Layman", () => {
  const projection = createStandardWorkspaceProjection(fixtureProjection());

  assert.deepEqual(standardWorkspaceAction(projection, { kind: "select", instanceId: "first" }), {
    kind: "select",
    instanceId: "first",
  });
  assert.equal(standardWorkspaceAction(projection, { kind: "select", instanceId: "second" }), null);
  assert.equal(standardWorkspaceAction(projection, { kind: "close", instanceId: "first" }), null);
  assert.deepEqual(standardWorkspaceAction(projection, { kind: "close", instanceId: "second" }), {
    kind: "close",
    instanceId: "second",
  });
});

test("standard projection renders an empty document as the terminal state", () => {
  const projection = createStandardWorkspaceProjection(fixtureProjection({ root: null }));

  assert.deepEqual(projection, { kind: "empty" });
  assert.equal(standardWorkspaceAction(projection, { kind: "select", instanceId: "first" }), null);
});

test("standard projection refuses layouts it cannot represent instead of flattening them", () => {
  const split = createStandardWorkspaceProjection(fixtureProjection({
    root: {
      kind: "split",
      nodeId: "fixture.split",
      axis: "horizontal",
      firstShare: 0.5,
      first: {
        kind: "stack",
        stackId: "fixture.first",
        instanceIds: ["first"],
        selectedInstanceId: "first",
      },
      second: {
        kind: "stack",
        stackId: "fixture.second",
        instanceIds: ["second"],
        selectedInstanceId: "second",
      },
    },
  }));

  assert.deepEqual(split, { kind: "unsupported", reason: "split" });
  assert.equal(standardWorkspaceAction(split, { kind: "select", instanceId: "first" }), null);
});
