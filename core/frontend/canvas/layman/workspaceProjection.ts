import type {
  WorkspaceNode,
  WorkspaceStackNode,
} from "@shipctl/module-api";
import type { WorkspaceCanvasProjection } from "@shipctl/core/workspace";
import {
  createLaymanNode,
  createLaymanTab,
  createLaymanWindow,
  type LaymanState,
  type LaymanTree,
} from "react-layman";

/** Data needed by the Layman adapter to render one semantic workspace tab. */
export interface LaymanWorkspaceViewPaneData {
  readonly kind: "shipctl.workspace-view";
  readonly instanceId: string;
  readonly viewTypeId: string;
  readonly availability: "available" | "missing-definition";
  readonly closeable: boolean;
  readonly splitAllowed: boolean;
}

export type LaymanCanvasPaneData = LaymanWorkspaceViewPaneData;

export const LAYMAN_WORKSPACE_STACK_PREFIX = "shipctl.workspace.stack:";
export const LAYMAN_WORKSPACE_SPLIT_PREFIX = "shipctl.workspace.split:";
export const LAYMAN_WORKSPACE_FLOATING_PREFIX = "shipctl.workspace.floating:";

/** Recover a semantic stack identity from a tiled Layman window identity. */
export function workspaceStackIdFromLaymanWindowId(windowId: string): string | null {
  if (!windowId.startsWith(LAYMAN_WORKSPACE_STACK_PREFIX)) return null;
  const stackId = windowId.slice(LAYMAN_WORKSPACE_STACK_PREFIX.length);
  return stackId.length === 0 ? null : stackId;
}

function tabFor(
  projection: WorkspaceCanvasProjection,
  instanceId: string,
) {
  const view = projection.views.find((candidate) => candidate.instance.instanceId === instanceId);
  if (view === undefined) {
    throw new Error(`Semantic workspace stack references missing instance ${instanceId}.`);
  }
  return createLaymanTab<LaymanCanvasPaneData>(
    view.title,
    {
      kind: "shipctl.workspace-view",
      instanceId: view.instance.instanceId,
      viewTypeId: view.instance.viewTypeId,
      availability: view.instance.availability.kind,
      closeable: view.closeable,
      splitAllowed: view.splitAllowed,
    },
    view.instance.instanceId,
  );
}

function windowFor(
  projection: WorkspaceCanvasProjection,
  stack: WorkspaceStackNode,
  id: string,
) {
  return createLaymanWindow(
    stack.instanceIds.map((instanceId) => tabFor(projection, instanceId)),
    id,
    stack.selectedInstanceId,
  );
}

function withViewPercent(
  tree: LaymanTree<LaymanCanvasPaneData>,
  viewPercent: number,
): LaymanTree<LaymanCanvasPaneData> {
  return { ...tree, viewPercent };
}

function treeFor(
  projection: WorkspaceCanvasProjection,
  node: WorkspaceNode,
): LaymanTree<LaymanCanvasPaneData> {
  if (node.kind === "stack") {
    return windowFor(projection, node, `${LAYMAN_WORKSPACE_STACK_PREFIX}${node.stackId}`);
  }
  const first = withViewPercent(treeFor(projection, node.first), node.firstShare * 100);
  const second = withViewPercent(treeFor(projection, node.second), (1 - node.firstShare) * 100);
  return createLaymanNode(
    node.axis === "horizontal" ? "row" : "column",
    [first, second],
    `${LAYMAN_WORKSPACE_SPLIT_PREFIX}${node.nodeId}`,
  );
}

/**
 * Project the semantic document into Layman state. This is a one-way adapter:
 * the output is transient renderer state and is never persisted as workspace
 * state. Layman has no controlled maximized-stack field, so a future maximize
 * command requires an explicit adapter extension before it can be exposed.
 */
export function createLaymanWorkspaceState(
  projection: WorkspaceCanvasProjection,
): LaymanState<LaymanCanvasPaneData> {
  return {
    layout: projection.document.root === null
      ? undefined
      : treeFor(projection, projection.document.root),
    floatingWindows: projection.document.floating.map((floating, index) => ({
      id: `${LAYMAN_WORKSPACE_FLOATING_PREFIX}${floating.floatingId}`,
      tabs: floating.stack.instanceIds.map((instanceId) => tabFor(projection, instanceId)),
      selectedTabId: floating.stack.selectedInstanceId,
      position: {
        top: floating.y,
        left: floating.x,
        width: floating.width,
        height: floating.height,
      },
      zIndex: index + 1,
    })),
  };
}
