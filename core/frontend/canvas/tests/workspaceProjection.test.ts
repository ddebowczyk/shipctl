import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createServer, type ViteDevServer } from "vite";
import type { WorkspaceCanvasProjection } from "@shipctl/core/workspace";
import type { UiWorkspaceDocument, WorkspaceRevision } from "@shipctl/module-api";

type ProjectionModule = typeof import("../layman/workspaceProjection.ts");
type LaymanCanvasModule = typeof import("../layman/LaymanCanvas.tsx");

let vite: ViteDevServer;
let createLaymanWorkspaceState: ProjectionModule["createLaymanWorkspaceState"];
let createLaymanCanvasController: LaymanCanvasModule["createLaymanCanvasController"];

before(async () => {
  vite = await createServer({
    server: { hmr: false, middlewareMode: true },
    appType: "custom",
  });
  ({ createLaymanWorkspaceState } = await vite.ssrLoadModule(
    "/core/frontend/canvas/layman/workspaceProjection.ts",
  ) as ProjectionModule);
  ({ createLaymanCanvasController } = await vite.ssrLoadModule(
    "/core/frontend/canvas/layman/LaymanCanvas.tsx",
  ) as LaymanCanvasModule);
});

after(async () => {
  await vite.close();
});

function fixtureProjection(): WorkspaceCanvasProjection {
  const document: UiWorkspaceDocument = {
    schemaVersion: 1,
    workspaceId: "fixture.workspace",
    profileId: "fixture.profile",
    instances: [
      {
        instanceId: "left",
        viewTypeId: "fixture.left",
        ownerModuleId: "shipctl.fixture",
        ownerActivationId: "shipctl.fixture@1#canvas",
        resource: { kind: "global" },
        label: "Left",
        stateRef: null,
        availability: { kind: "available" },
        lifecycle: "placed",
      },
      {
        instanceId: "right",
        viewTypeId: "fixture.right",
        ownerModuleId: "shipctl.fixture",
        ownerActivationId: "shipctl.fixture@1#canvas",
        resource: { kind: "global" },
        label: "Right",
        stateRef: null,
        availability: {
          kind: "missing-definition",
          lastKnownViewTypeId: "fixture.right",
          catalogRevision: 7,
        },
        lifecycle: "placed",
      },
      {
        instanceId: "floating",
        viewTypeId: "fixture.floating",
        ownerModuleId: "shipctl.fixture",
        ownerActivationId: "shipctl.fixture@1#canvas",
        resource: { kind: "global" },
        label: "Floating",
        stateRef: null,
        availability: { kind: "available" },
        lifecycle: "placed",
      },
    ],
    root: {
      kind: "split",
      nodeId: "main",
      axis: "horizontal",
      firstShare: 0.25,
      first: {
        kind: "stack",
        stackId: "left-stack",
        instanceIds: ["left"],
        selectedInstanceId: "left",
      },
      second: {
        kind: "stack",
        stackId: "right-stack",
        instanceIds: ["right"],
        selectedInstanceId: "right",
      },
    },
    floating: [{
      floatingId: "inspector",
      stack: {
        kind: "stack",
        stackId: "floating-stack",
        instanceIds: ["floating"],
        selectedInstanceId: "floating",
      },
      x: 12,
      y: 24,
      width: 480,
      height: 320,
    }],
    maximizedStackId: null,
  };
  return {
    workspaceId: document.workspaceId,
    revision: 4 as WorkspaceRevision,
    catalogRevision: 7,
    document,
    views: [
      {
        instance: document.instances[0]!,
        definition: null,
        title: "Left",
        closeable: false,
        splitAllowed: false,
      },
      {
        instance: document.instances[1]!,
        definition: null,
        title: "Right",
        closeable: true,
        splitAllowed: false,
      },
      {
        instance: document.instances[2]!,
        definition: null,
        title: "Floating",
        closeable: true,
        splitAllowed: true,
      },
    ],
  };
}

function tabInteractionProjection(): WorkspaceCanvasProjection {
  const source = fixtureProjection();
  const document: UiWorkspaceDocument = {
    ...source.document,
    root: {
      kind: "stack",
      stackId: "interaction-stack",
      instanceIds: ["left", "right"],
      selectedInstanceId: "left",
    },
    floating: [],
  };
  return {
    ...source,
    document,
    views: source.views.slice(0, 2),
  };
}

test("Layman projection preserves semantic stacks, tabs, split shares, and floating geometry", () => {
  const state = createLaymanWorkspaceState(fixtureProjection());
  assert.deepEqual(state, {
    layout: {
      id: "shipctl.workspace.split:main",
      direction: "row",
      children: [
        {
          id: "shipctl.workspace.stack:left-stack",
          tabs: [{
            id: "left",
            title: "Left",
            data: {
              kind: "shipctl.workspace-view",
              instanceId: "left",
              viewTypeId: "fixture.left",
              availability: "available",
              closeable: false,
            },
          }],
          selectedTabId: "left",
          viewPercent: 25,
        },
        {
          id: "shipctl.workspace.stack:right-stack",
          tabs: [{
            id: "right",
            title: "Right",
            data: {
              kind: "shipctl.workspace-view",
              instanceId: "right",
              viewTypeId: "fixture.right",
              availability: "missing-definition",
              closeable: true,
            },
          }],
          selectedTabId: "right",
          viewPercent: 75,
        },
      ],
    },
    floatingWindows: [{
      id: "shipctl.workspace.floating:inspector",
      tabs: [{
        id: "floating",
        title: "Floating",
        data: {
          kind: "shipctl.workspace-view",
          instanceId: "floating",
          viewTypeId: "fixture.floating",
          availability: "available",
          closeable: true,
        },
      }],
      selectedTabId: "floating",
      position: { top: 24, left: 12, width: 480, height: 320 },
      zIndex: 1,
    }],
  });
});

test("Layman accepts only semantic tab selection and close actions", () => {
  const controller = createLaymanCanvasController(
    createLaymanWorkspaceState(tabInteractionProjection()),
  );

  assert.equal(
    controller.dispatch({ type: "tab.select", tabId: "right" }, { origin: "user" }).status,
    "applied",
  );
  assert.equal(
    controller.dispatch({ type: "tab.remove", tabId: "left" }, { origin: "user" }).status,
    "rejected",
  );
  assert.equal(
    controller.dispatch({ type: "tab.remove", tabId: "right" }, { origin: "user" }).status,
    "applied",
  );
});
