import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createServer, type ViteDevServer } from "vite";
import type { UiWorkspaceDocument, WorkspaceRevision } from "@shipctl/module-api";
import type { WorkspaceCanvasProjection } from "@shipctl/core/workspace";
import type { LaymanSnapshotPort, LaymanWorkspaceUpdate } from "../layman/workspaceBridge.ts";

type LaymanModule = typeof import("../layman/workspaceBridge.ts");
type LaymanCanvasModule = typeof import("../layman/LaymanCanvas.tsx");
type LaymanWorkspaceProjectionModule = typeof import("../layman/workspaceProjection.ts");

let vite: ViteDevServer;
let createLaymanWorkspaceBridge: LaymanModule["createLaymanWorkspaceBridge"];
let serializeState: LaymanModule["serializeState"];
let createLaymanCanvasController: LaymanCanvasModule["createLaymanCanvasController"];
let LAYMAN_CANVAS_WORKSPACE_ID: LaymanCanvasModule["LAYMAN_CANVAS_WORKSPACE_ID"];
let createLaymanWorkspaceState: LaymanWorkspaceProjectionModule["createLaymanWorkspaceState"];

before(async () => {
  vite = await createServer({
    server: { hmr: false, middlewareMode: true },
    appType: "custom",
  });
  ({
    createLaymanWorkspaceBridge,
    serializeState,
  } = await vite.ssrLoadModule(
    "/core/frontend/canvas/layman/workspaceBridge.ts",
  ) as LaymanModule);
  ({
    createLaymanCanvasController,
    LAYMAN_CANVAS_WORKSPACE_ID,
  } = await vite.ssrLoadModule(
    "/core/frontend/canvas/layman/LaymanCanvas.tsx",
  ) as LaymanCanvasModule);
  ({ createLaymanWorkspaceState } = await vite.ssrLoadModule(
    "/core/frontend/canvas/layman/workspaceProjection.ts",
  ) as LaymanWorkspaceProjectionModule);
});

after(async () => {
  await vite.close();
});

function semanticProjection(): WorkspaceCanvasProjection {
  const document: UiWorkspaceDocument = {
    schemaVersion: 2,
    workspaceId: "fixture.workspace",
    instances: [{
      instanceId: "fixture.surface",
      viewTypeId: "fixture.surface",
      ownerModuleId: "fixture",
      ownerActivationId: "fixture@1#surface" as never,
      resource: { kind: "global" },
      label: "Fixture surface",
      availability: { kind: "available" },
      lifecycle: "placed",
    }],
    root: {
      kind: "stack",
      stackId: "fixture.primary",
      instanceIds: ["fixture.surface"],
      selectedInstanceId: "fixture.surface",
    },
    floating: [],
    maximizedStackId: null,
  };
  return {
    workspaceId: document.workspaceId,
    revision: 1 as WorkspaceRevision,
    catalogRevision: 1,
    document,
    views: [{
      instance: document.instances[0]!,
      definition: null,
      title: "Fixture surface",
      closeable: true,
      splitAllowed: true,
    }],
  };
}

function semanticController() {
  const controller = createLaymanCanvasController(createLaymanWorkspaceState(semanticProjection()));
  const layout = controller.getState().layout;
  if (!layout || !("tabs" in layout)) {
    throw new Error("fixture requires a semantic Layman workspace window");
  }
  return { controller, windowId: layout.id };
}

function snapshotWithTitle(title: string) {
  const snapshot = structuredClone(serializeState(semanticController().controller.getState()));
  if (!snapshot.layout || snapshot.layout.kind !== "window") {
    throw new Error("fixture requires the initial Layman canvas window");
  }
  snapshot.layout.tabs[0]!.title = title;
  return snapshot;
}

function titleOf(snapshot: ReturnType<LaymanModule["serializeState"]>) {
  if (!snapshot.layout || snapshot.layout.kind !== "window") {
    throw new Error("fixture requires the initial Layman canvas window");
  }
  return snapshot.layout.tabs[0]?.title;
}

test("restores one record, ignores a delayed stale update, and applies a newer external update", async () => {
  let receive: ((update: LaymanWorkspaceUpdate) => void) | undefined;
  const snapshotPort = {
    load: async (workspaceId: string) => {
      assert.equal(workspaceId, LAYMAN_CANVAS_WORKSPACE_ID);
      return {
        revision: 4,
        originId: "saved-webview",
        snapshot: snapshotWithTitle("Saved canvas"),
      };
    },
    compareAndSave: async (_workspaceId, request) => ({
      status: "saved" as const,
      update: {
        revision: request.expectedRevision + 1,
        originId: request.originId,
        snapshot: request.snapshot,
      },
    }),
    subscribe: async (workspaceId: string, listener: (update: LaymanWorkspaceUpdate) => void) => {
      assert.equal(workspaceId, LAYMAN_CANVAS_WORKSPACE_ID);
      receive = listener;
      return () => {
        receive = undefined;
      };
    },
  } satisfies LaymanSnapshotPort;
  const { controller } = semanticController();
  const bridge = createLaymanWorkspaceBridge({
    workspaceId: LAYMAN_CANVAS_WORKSPACE_ID,
    originId: "active-webview",
    controller,
    snapshots: snapshotPort,
  });

  await bridge.start();
  assert.equal(bridge.inspect().revision, 4);
  assert.equal(titleOf(bridge.inspect().snapshot), "Saved canvas");

  const beforeStale = controller.getState();
  receive?.({
    revision: 3,
    originId: "delayed-webview",
    snapshot: snapshotWithTitle("Stale canvas"),
  });
  assert.strictEqual(controller.getState(), beforeStale);
  assert.equal(bridge.inspect().revision, 4);

  receive?.({
    revision: 5,
    originId: "other-webview",
    snapshot: snapshotWithTitle("External canvas"),
  });
  assert.equal(bridge.inspect().revision, 5);
  assert.equal(titleOf(bridge.inspect().snapshot), "External canvas");

  await bridge.stop();
});

test("a failed save retains the active in-memory canvas and emits a diagnostics event", async () => {
  const events: string[] = [];
  const snapshotPort = {
    load: async () => undefined,
    compareAndSave: async () => {
      throw new Error("CANVAS_LAYOUT_REVISION_CONFLICT: a newer canvas exists");
    },
  } satisfies LaymanSnapshotPort;
  const { controller, windowId } = semanticController();
  const bridge = createLaymanWorkspaceBridge({
    workspaceId: LAYMAN_CANVAS_WORKSPACE_ID,
    originId: "active-webview",
    controller,
    snapshots: snapshotPort,
    onEvent(event) {
      if (event.type === "save-failed") events.push(event.message);
    },
  });

  await bridge.start();
  const transition = bridge.dispatch({
    type: "window.move",
    windowId,
    target: {
      kind: "floating",
      position: { top: 8, left: 8, width: 640, height: 480 },
    },
    placement: "center",
  });
  await bridge.flush();

  assert.equal(transition.status, "applied");
  assert.equal(controller.getState().layout, undefined);
  assert.equal(controller.getState().floatingWindows.length, 1);
  assert.deepEqual(events, ["CANVAS_LAYOUT_REVISION_CONFLICT: a newer canvas exists"]);

  await bridge.stop();
});

test("a compare-and-save conflict restores the confirmed canvas and drops stale local work", async () => {
  const events: string[] = [];
  const expectedRevisions: number[] = [];
  const snapshotPort = {
    load: async () => undefined,
    compareAndSave: async (_workspaceId: string, request: { expectedRevision: number }) => {
      expectedRevisions.push(request.expectedRevision);
      return {
        status: "conflict" as const,
        current: {
          revision: 2,
          originId: "other-webview",
          snapshot: snapshotWithTitle("Confirmed canvas"),
        },
      };
    },
  } satisfies LaymanSnapshotPort;
  const { controller, windowId } = semanticController();
  const bridge = createLaymanWorkspaceBridge({
    workspaceId: LAYMAN_CANVAS_WORKSPACE_ID,
    originId: "active-webview",
    controller,
    snapshots: snapshotPort,
    onEvent(event) {
      if (event.type === "save-conflicted" || event.type === "save-failed") {
        events.push(event.type);
      }
    },
  });

  await bridge.start();
  const transition = bridge.dispatch({
    type: "window.move",
    windowId,
    target: {
      kind: "floating",
      position: { top: 8, left: 8, width: 640, height: 480 },
    },
    placement: "center",
  });
  await bridge.flush();

  assert.equal(transition.status, "applied");
  assert.deepEqual(expectedRevisions, [0]);
  assert.equal(bridge.inspect().revision, 2);
  assert.equal(titleOf(bridge.inspect().snapshot), "Confirmed canvas");
  assert.equal(controller.getState().floatingWindows.length, 0);
  assert.deepEqual(events, ["save-conflicted"]);

  await bridge.stop();
});
