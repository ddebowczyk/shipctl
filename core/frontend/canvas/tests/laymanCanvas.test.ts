import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";

import type {
  UiWorkspaceDocument,
  WorkspaceRevision,
} from "@shipctl/module-api";
import type { WorkspaceCanvasProjection } from "@shipctl/core/workspace";
import { createServer, type ViteDevServer } from "vite";

type LaymanCanvasModule = typeof import("../layman/LaymanCanvas.tsx");
type LaymanWorkspaceProjectionModule = typeof import("../layman/workspaceProjection.ts");

let vite: ViteDevServer;
let createLaymanCanvasController: LaymanCanvasModule["createLaymanCanvasController"];
let createLaymanCanvasState: LaymanCanvasModule["createLaymanCanvasState"];
let LAYMAN_SOURCE_REVISION: LaymanCanvasModule["LAYMAN_SOURCE_REVISION"];
let createLaymanWorkspaceState: LaymanWorkspaceProjectionModule["createLaymanWorkspaceState"];

const LAYMAN_GITHUB_REVISION = "8d0c41a0a52830f3072771af674d63d80215384e";

before(async () => {
  vite = await createServer({
    server: { hmr: false, middlewareMode: true },
    appType: "custom",
  });
  ({
    createLaymanCanvasController,
    createLaymanCanvasState,
    LAYMAN_SOURCE_REVISION,
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
    instances: [
      {
        instanceId: "fixture.panel:/repo",
        viewTypeId: "fixture.panel",
        ownerModuleId: "fixture",
        ownerActivationId: "fixture@1#panel" as never,
        resource: { kind: "project", projectId: "/repo" },
        label: "Fixture panel",
        availability: { kind: "available" },
        lifecycle: "placed",
      },
    ],
    root: {
      kind: "stack",
      stackId: "fixture.primary",
      instanceIds: ["fixture.panel:/repo"],
      selectedInstanceId: "fixture.panel:/repo",
    },
    floating: [],
    maximizedStackId: null,
  };
  return {
    workspaceId: document.workspaceId,
    revision: 1 as WorkspaceRevision,
    catalogRevision: 1,
    document,
    views: document.instances.map((instance) => ({
      instance,
      definition: null,
      title: instance.label ?? instance.viewTypeId,
      closeable: true,
      splitAllowed: true,
    })),
  };
}

test("initializes an empty semantic state before the workspace bridge is available", () => {
  assert.deepEqual(createLaymanCanvasState(), {
    layout: undefined,
    floatingWindows: [],
  });
});

test("projects admitted semantic views into Layman state without an imperative canvas model", () => {
  const state = createLaymanWorkspaceState(semanticProjection());
  const layout = state.layout;

  assert.ok(layout && "tabs" in layout);
  if (!layout || !("tabs" in layout)) return;
  assert.deepEqual(layout.tabs.map((tab) => tab.data), [
    {
      kind: "shipctl.workspace-view",
      instanceId: "fixture.panel:/repo",
      viewTypeId: "fixture.panel",
      availability: "available",
      closeable: true,
      splitAllowed: true,
    },
  ]);
  assert.equal(layout.selectedTabId, "fixture.panel:/repo");
});

test("host-only Layman transitions stay local to the selected renderer", () => {
  const initialState = createLaymanWorkspaceState(semanticProjection());
  const layout = initialState.layout;
  assert.ok(layout && "tabs" in layout);
  if (!layout || !("tabs" in layout)) return;
  const controller = createLaymanCanvasController(initialState);
  const before = controller.getState();
  const transition = controller.dispatch({
    type: "window.move",
    windowId: layout.id,
    target: {
      kind: "floating",
      position: { top: 8, left: 8, width: 640, height: 480 },
    },
    placement: "center",
  }, { origin: "host" });

  assert.equal(transition.status, "applied");
  assert.notStrictEqual(controller.getState(), before);
  assert.equal(controller.getState().layout, undefined);
  assert.equal(controller.getState().floatingWindows.length, 1);
});

test("uses the approved React source and hosts contributed views through the workspace contract", async () => {
  const packageManifest = JSON.parse(await readFile("core/frontend/package.json", "utf8")) as {
    dependencies: Record<string, string>;
  };
  assert.equal(
    packageManifest.dependencies["react-layman"],
    `github:ddebowczyk/react-layman#${LAYMAN_GITHUB_REVISION}`,
  );
  assert.equal(LAYMAN_SOURCE_REVISION, LAYMAN_GITHUB_REVISION);

  const source = await readFile("core/frontend/canvas/layman/LaymanCanvas.tsx", "utf8");
  const themeBridge = await readFile("core/frontend/canvas/layman/laymanCanvas.css", "utf8");
  assert.match(source, /from "react-layman"/);
  assert.match(source, /import "react-layman\/styles\.css"/);
  assert.match(source, /import "\.\/laymanCanvas\.css"/);
  assert.match(source, /position: "relative", flex: 1, height: "100%"/);
  assert.match(themeBridge, /--layman-window-background: transparent/);
  assert.match(themeBridge, /--layman-tab-text-color: var\(--text-secondary\)/);
  assert.match(themeBridge, /--layman-accent-color: var\(--status-running\)/);
  assert.match(source, /WorkspaceViewHost workspace=\{workspace\}/);
  assert.match(source, /TerminalStage visible=/);
  assert.match(source, /display: semanticViewSelected \? "none" : "flex"/);
  assert.doesNotMatch(source, /shipctl\.legacy-canvas|CanvasModel|CanvasActions|CanvasPorts|@tauri-apps|invoke\(/);
});
