import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { UiWorkspaceDocument, WorkspaceRevision } from "@shipctl/module-api";
import type { WorkspaceCanvas } from "../canvasBridge.ts";
import { createServer, type ViteDevServer } from "vite";

type ProjectionModule = typeof import("../workspaceTabProjection.ts");

let vite: ViteDevServer;
let projectSingleStackWorkspaceTabs: ProjectionModule["projectSingleStackWorkspaceTabs"];
let workspaceNeedsInternalTabStrip: ProjectionModule["workspaceNeedsInternalTabStrip"];

before(async () => {
  vite = await createServer({
    server: { hmr: false, middlewareMode: true },
    appType: "custom",
  });
  ({
    projectSingleStackWorkspaceTabs,
    workspaceNeedsInternalTabStrip,
  } = await vite.ssrLoadModule(
    "/core/frontend/workspace/workspaceTabProjection.ts",
  ) as ProjectionModule);
});

after(async () => {
  await vite.close();
});

function canvas(document: UiWorkspaceDocument): WorkspaceCanvas {
  return {
    projection: {
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
    },
    execute: async () => ({}) as never,
  };
}

function singleStackDocument(): UiWorkspaceDocument {
  const instances = ["commands", "todos"].map((id) => ({
    instanceId: id,
    viewTypeId: `shipctl.${id}`,
    ownerModuleId: "shipctl.fixture",
    ownerActivationId: "shipctl.fixture@1#active" as never,
    resource: { kind: "project" as const, projectId: "/fixture" },
    label: id === "commands" ? "Commands" : "To-dos",
    availability: { kind: "available" as const },
    lifecycle: "placed" as const,
  }));
  return {
    schemaVersion: 2,
    workspaceId: "fixture.workspace",
    instances,
    root: {
      kind: "stack",
      stackId: "primary",
      instanceIds: instances.map(({ instanceId }) => instanceId),
      selectedInstanceId: "todos",
    },
    floating: [],
    maximizedStackId: null,
  };
}

test("single-stack semantic views join the host tab strip", () => {
  const workspace = canvas(singleStackDocument());

  assert.deepEqual(projectSingleStackWorkspaceTabs(workspace), [
    {
      id: "commands",
      label: "Commands",
      viewTypeId: "shipctl.commands",
      selected: false,
      closeable: true,
    },
    {
      id: "todos",
      label: "To-dos",
      viewTypeId: "shipctl.todos",
      selected: true,
      closeable: true,
    },
  ]);
  assert.equal(workspaceNeedsInternalTabStrip(workspace), false);
});

test("split workspaces retain renderer-owned per-stack tab strips", () => {
  const document = singleStackDocument();
  const workspace = canvas({
    ...document,
    root: {
      kind: "split",
      nodeId: "split",
      axis: "horizontal",
      firstShare: 0.5,
      first: {
        kind: "stack",
        stackId: "left",
        instanceIds: ["commands"],
        selectedInstanceId: "commands",
      },
      second: {
        kind: "stack",
        stackId: "right",
        instanceIds: ["todos"],
        selectedInstanceId: "todos",
      },
    },
  });

  assert.deepEqual(projectSingleStackWorkspaceTabs(workspace), []);
  assert.equal(workspaceNeedsInternalTabStrip(workspace), true);
});
