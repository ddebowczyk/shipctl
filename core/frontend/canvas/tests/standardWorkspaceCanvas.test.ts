import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";

import type {
  UiWorkspaceDocument,
  WorkspaceMutationResult,
  WorkspaceRevision,
} from "@shipctl/module-api";
import type {
  WorkspaceCanvas,
  WorkspaceCanvasProjection,
} from "@shipctl/core/workspace";
import { createServer, type ViteDevServer } from "vite";

type StandardWorkspaceProjectionModule = typeof import("../standard/workspaceProjection.ts");

let vite: ViteDevServer;
let createStandardWorkspaceProjection: StandardWorkspaceProjectionModule["createStandardWorkspaceProjection"];
let standardWorkspaceAction: StandardWorkspaceProjectionModule["standardWorkspaceAction"];

before(async () => {
  vite = await createServer({
    server: { hmr: false, middlewareMode: true },
    appType: "custom",
  });
  ({ createStandardWorkspaceProjection, standardWorkspaceAction } = await vite.ssrLoadModule(
    "/core/frontend/canvas/standard/workspaceProjection.ts",
  ) as StandardWorkspaceProjectionModule);
});

after(async () => {
  await vite.close();
});

function semanticCanvas(): WorkspaceCanvas {
  const document: UiWorkspaceDocument = {
    schemaVersion: 2,
    workspaceId: "fixture.workspace",
    instances: [
      {
        instanceId: "fixture.global",
        viewTypeId: "fixture.global-surface",
        ownerModuleId: "fixture",
        ownerActivationId: "fixture@1#surface" as never,
        resource: { kind: "global" },
        label: "Fixture surface",
        availability: { kind: "available" },
        lifecycle: "placed",
      },
    ],
    root: {
      kind: "stack",
      stackId: "fixture.primary",
      instanceIds: ["fixture.global"],
      selectedInstanceId: "fixture.global",
    },
    floating: [],
    maximizedStackId: null,
  };
  const projection: WorkspaceCanvasProjection = {
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
  return {
    projection,
    execute: async () => ({}) as WorkspaceMutationResult,
  };
}

test("projects semantic workspace selection and maps only public workspace gestures", () => {
  const projection = createStandardWorkspaceProjection(semanticCanvas().projection);

  assert.equal(projection.kind, "stack");
  if (projection.kind !== "stack") return;
  assert.equal(projection.activeViewId, "fixture.global");
  assert.deepEqual(
    projection.views.map((view) => view.instance.viewTypeId),
    ["fixture.global-surface"],
  );
  assert.equal(
    standardWorkspaceAction(projection, {
      kind: "select",
      instanceId: "fixture.global",
    }),
    null,
  );
  assert.deepEqual(
    standardWorkspaceAction(projection, {
      kind: "close",
      instanceId: "fixture.global",
    }),
    { kind: "close", instanceId: "fixture.global" },
  );
});

test("keeps unsupported split layouts explicit instead of flattening them", () => {
  const canvas = semanticCanvas();
  const document: UiWorkspaceDocument = {
    ...canvas.projection.document,
    root: {
      kind: "split",
      nodeId: "fixture.split",
      axis: "horizontal",
      firstShare: 0.5,
      first: {
        kind: "stack",
        stackId: "fixture.left",
        instanceIds: ["fixture.global"],
        selectedInstanceId: "fixture.global",
      },
      second: {
        kind: "stack",
        stackId: "fixture.right",
        instanceIds: ["fixture.global"],
        selectedInstanceId: "fixture.global",
      },
    },
  };
  const projection = createStandardWorkspaceProjection({
    ...canvas.projection,
    document,
  });

  assert.deepEqual(projection, { kind: "unsupported", reason: "split" });
});

test("standard adapter receives only workspace state and delegates hosts to the standard runtime", async () => {
  const source = await readFile("core/frontend/canvas/standard/StandardWorkspaceCanvas.tsx", "utf8");

  assert.match(source, /WorkspaceViewHost/);
  assert.match(source, /TerminalStage/);
  assert.match(source, /extends CanvasAdapterProps/);
  assert.doesNotMatch(source, /shipctl\.legacy-canvas|CanvasModel|CanvasActions|CanvasPorts|CanvasViewPorts/);
});

test("the shell owns standard chrome and passes only the semantic workspace to the adapter", async () => {
  const source = await readFile("core/frontend/shell/AppShell.tsx", "utf8");

  assert.match(source, /StandardWorkspaceFrame/);
  assert.match(source, /StandardWorkspaceNavigation/);
  assert.match(source, /StandardWorkspaceTabs/);
  assert.match(source, /TerminalPresentationRuntimeProvider/);
  assert.match(source, /<CanvasHost adapter=\{canvasAdapter\} workspace=\{workspaceCanvas\} \/>/);
  assert.doesNotMatch(source, /legacy\/|createCanvasModel|CanvasActions|CanvasPorts/);
});
