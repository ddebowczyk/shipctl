import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";

import { createServer, type ViteDevServer } from "vite";
import type {
  UiWorkspaceDocument,
  WorkspaceCatalogSnapshot,
} from "@shipctl/module-api";

type AuthorityModule = typeof import("../authority.ts");
type CatalogModule = typeof import("../catalog.ts");
type CanvasBridgeModule = typeof import("../canvasBridge.ts");
type PersistenceModule = typeof import("../persistence.ts");
type DocumentModule = typeof import("../document.ts");

let vite: ViteDevServer;
let WorkspaceAuthority: AuthorityModule["WorkspaceAuthority"];
let parseWorkspaceCatalogSnapshot: CatalogModule["parseWorkspaceCatalogSnapshot"];
let WorkspaceCanvasBridge: CanvasBridgeModule["WorkspaceCanvasBridge"];
let InMemoryWorkspacePersistence: PersistenceModule["InMemoryWorkspacePersistence"];
let parseUiWorkspaceDocument: DocumentModule["parseUiWorkspaceDocument"];

before(async () => {
  vite = await createServer({
    server: { hmr: false, middlewareMode: true },
    appType: "custom",
  });
  ({ WorkspaceAuthority } = await vite.ssrLoadModule(
    "/core/frontend/workspace/authority.ts",
  ) as AuthorityModule);
  ({ parseWorkspaceCatalogSnapshot } = await vite.ssrLoadModule(
    "/core/frontend/workspace/catalog.ts",
  ) as CatalogModule);
  ({ WorkspaceCanvasBridge } = await vite.ssrLoadModule(
    "/core/frontend/workspace/canvasBridge.ts",
  ) as CanvasBridgeModule);
  ({ InMemoryWorkspacePersistence } = await vite.ssrLoadModule(
    "/core/frontend/workspace/persistence.ts",
  ) as PersistenceModule);
  ({ parseUiWorkspaceDocument } = await vite.ssrLoadModule(
    "/core/frontend/workspace/document.ts",
  ) as DocumentModule);
});

after(async () => {
  await vite.close();
});

function catalog(viewTypeIds: readonly string[]): WorkspaceCatalogSnapshot {
  return parseWorkspaceCatalogSnapshot({
    schemaVersion: 1,
    revision: 1,
    definitions: viewTypeIds.map((viewTypeId) => ({
      viewTypeId,
      ownerModuleId: "shipctl.fixture",
      ownerActivationId: "shipctl.fixture@1#canvas",
      label: viewTypeId,
      scope: "global",
      cardinality: "multiple",
      closeBehavior: "dispose",
      requiredCapabilityIds: [],
      placement: { defaultRegion: "primary", allowSplit: true },
      state: { kind: "none" },
      presentation: { loaderId: viewTypeId, exportName: "default" },
      migrationAliases: [],
    })),
  });
}

function profile(workspaceId: string): UiWorkspaceDocument {
  return parseUiWorkspaceDocument({
    schemaVersion: 1,
    workspaceId,
    profileId: "fixture.canvas",
    instances: ["first", "second"].map((instanceId) => ({
      instanceId,
      viewTypeId: instanceId === "first" ? "fixture.first" : "fixture.second",
      ownerModuleId: "shipctl.fixture",
      ownerActivationId: "shipctl.fixture@1#canvas",
      resource: { kind: "global" },
      label: instanceId,
      stateRef: null,
      availability: { kind: "available" },
      lifecycle: "placed",
    })),
    root: {
      kind: "stack",
      stackId: "fixture.primary",
      instanceIds: ["first", "second"],
      selectedInstanceId: "first",
    },
    floating: [],
    maximizedStackId: null,
  });
}

function splitProfile(workspaceId: string): UiWorkspaceDocument {
  return parseUiWorkspaceDocument({
    schemaVersion: 1,
    workspaceId,
    profileId: "fixture.canvas",
    instances: ["first", "second", "third"].map((instanceId) => ({
      instanceId,
      viewTypeId: `fixture.${instanceId}`,
      ownerModuleId: "shipctl.fixture",
      ownerActivationId: "shipctl.fixture@1#canvas",
      resource: { kind: "global" },
      label: instanceId,
      stateRef: null,
      availability: { kind: "available" },
      lifecycle: "placed",
    })),
    root: {
      kind: "split",
      nodeId: "fixture.root",
      axis: "horizontal",
      firstShare: 0.5,
      first: {
        kind: "stack",
        stackId: "fixture.left",
        instanceIds: ["first", "second"],
        selectedInstanceId: "first",
      },
      second: {
        kind: "stack",
        stackId: "fixture.right",
        instanceIds: ["third"],
        selectedInstanceId: "third",
      },
    },
    floating: [],
    maximizedStackId: null,
  });
}

test("canvas bridge serializes renderer actions through current authority revisions", async () => {
  const workspaceId = "fixture.workspace";
  const authority = await WorkspaceAuthority.open({
    workspaceId,
    catalog: catalog(["fixture.first", "fixture.second"]),
    persistence: new InMemoryWorkspacePersistence(),
    defaultProfile: ({ workspaceId: id }) => profile(id),
  });
  const bridge = new WorkspaceCanvasBridge({ authority, originId: "fixture.canvas" });
  const observations: number[] = [];
  bridge.subscribe((canvas) => observations.push(canvas.projection.revision));

  const snapshot = bridge.snapshot();
  assert.deepEqual(snapshot.projection.views.map((view) => ({
    instanceId: view.instance.instanceId,
    title: view.title,
    closeable: view.closeable,
    splitAllowed: view.splitAllowed,
  })), [
    { instanceId: "first", title: "first", closeable: true, splitAllowed: true },
    { instanceId: "second", title: "second", closeable: true, splitAllowed: true },
  ]);

  const [selected, closed] = await Promise.all([
    snapshot.execute({ kind: "select", instanceId: "second" }),
    snapshot.execute({ kind: "close", instanceId: "second" }),
  ]);
  assert.equal(selected.revision, 1);
  assert.equal(closed.revision, 2);
  assert.deepEqual(observations, [1, 2]);
  assert.deepEqual(authority.inspect(true).document?.root, {
    kind: "stack",
    stackId: "fixture.primary",
    instanceIds: ["first"],
    selectedInstanceId: "first",
  });

  bridge.dispose();
});

test("canvas bridge opens semantic views without exposing an authority or renderer", async () => {
  const workspaceId = "fixture.workspace";
  const authority = await WorkspaceAuthority.open({
    workspaceId,
    catalog: catalog(["fixture.first", "fixture.second", "fixture.global"]),
    persistence: new InMemoryWorkspacePersistence(),
    defaultProfile: ({ workspaceId: id }) => profile(id),
  });
  const bridge = new WorkspaceCanvasBridge({ authority, originId: "fixture.canvas" });

  const opened = await bridge.snapshot().execute({
    kind: "open",
    instanceId: "fixture.global.instance",
    viewTypeId: "fixture.global",
    resource: { kind: "global" },
  });

  assert.equal(opened.status, "applied");
  const document = authority.inspect(true).document;
  assert.deepEqual(document?.root, {
    kind: "stack",
    stackId: "fixture.primary",
    instanceIds: ["first", "second", "fixture.global.instance"],
    selectedInstanceId: "fixture.global.instance",
  });
  assert.equal(
    document?.instances.find((instance) => instance.instanceId === "fixture.global.instance")?.viewTypeId,
    "fixture.global",
  );

  bridge.dispose();
});

test("canvas bridge moves semantic views through the authority", async () => {
  const workspaceId = "fixture.workspace";
  const authority = await WorkspaceAuthority.open({
    workspaceId,
    catalog: catalog(["fixture.first", "fixture.second", "fixture.third"]),
    persistence: new InMemoryWorkspacePersistence(),
    defaultProfile: ({ workspaceId: id }) => splitProfile(id),
  });
  const bridge = new WorkspaceCanvasBridge({ authority, originId: "fixture.canvas" });

  const moved = await bridge.snapshot().execute({
    kind: "move",
    instanceId: "first",
    targetStackId: "fixture.right",
    position: "end",
    relativeInstanceId: null,
  });

  assert.equal(moved.status, "applied");
  assert.equal(moved.revision, 1);
  assert.deepEqual(authority.inspect(true).document?.root, {
    kind: "split",
    nodeId: "fixture.root",
    axis: "horizontal",
    firstShare: 0.5,
    first: {
      kind: "stack",
      stackId: "fixture.left",
      instanceIds: ["second"],
      selectedInstanceId: "second",
    },
    second: {
      kind: "stack",
      stackId: "fixture.right",
      instanceIds: ["third", "first"],
      selectedInstanceId: "first",
    },
  });

  bridge.dispose();
});

test("canvas bridge allocates semantic split identities without a renderer", async () => {
  const workspaceId = "fixture.workspace";
  const authority = await WorkspaceAuthority.open({
    workspaceId,
    catalog: catalog(["fixture.first", "fixture.second"]),
    persistence: new InMemoryWorkspacePersistence(),
    defaultProfile: ({ workspaceId: id }) => profile(id),
  });
  const bridge = new WorkspaceCanvasBridge({ authority, originId: "fixture.canvas" });

  const split = await bridge.snapshot().execute({
    kind: "split",
    instanceId: "first",
    targetStackId: "fixture.primary",
    axis: "horizontal",
    position: "after",
  });

  assert.deepEqual(split.affectedStackIds, ["fixture.primary", "shipctl.workspace.stack.1"]);
  assert.deepEqual(authority.inspect(true).document?.root, {
    kind: "split",
    nodeId: "shipctl.workspace.split.1",
    axis: "horizontal",
    firstShare: 0.5,
    first: {
      kind: "stack",
      stackId: "fixture.primary",
      instanceIds: ["second"],
      selectedInstanceId: "second",
    },
    second: {
      kind: "stack",
      stackId: "shipctl.workspace.stack.1",
      instanceIds: ["first"],
      selectedInstanceId: "first",
    },
  });

  bridge.dispose();
});

test("canvas bridge keeps removed definitions recoverable and closeable", async () => {
  const workspaceId = "fixture.workspace";
  const authority = await WorkspaceAuthority.open({
    workspaceId,
    catalog: catalog(["fixture.first", "fixture.second"]),
    persistence: new InMemoryWorkspacePersistence(),
    defaultProfile: ({ workspaceId: id }) => profile(id),
  });
  const bridge = new WorkspaceCanvasBridge({ authority });

  await authority.reconcileCatalog({
    catalog: catalog(["fixture.first"]),
    expectedRevision: authority.revision,
    originId: "fixture.catalog",
  });
  const removed = bridge.snapshot().projection.views.find((view) => (
    view.instance.instanceId === "second"
  ));
  assert.equal(removed?.definition, null);
  assert.equal(removed?.instance.availability.kind, "missing-definition");
  assert.equal(removed?.closeable, true);

  bridge.dispose();
});

test("canvas bridge remains renderer and transport independent", async () => {
  const source = await readFile("core/frontend/workspace/canvasBridge.ts", "utf8");
  assert.doesNotMatch(source, /@tauri-apps\//);
  assert.doesNotMatch(source, /react-layman/);
  assert.doesNotMatch(source, /from ["']react["']/);
});
