import type {
  WorkspaceCanvasAction,
  WorkspaceCanvasProjection,
  WorkspaceCanvasView,
} from "@shipctl/core/workspace";

/** The standard adapter can presently represent one root tab stack only. */
export interface StandardWorkspaceStackProjection {
  readonly kind: "stack";
  readonly stackId: string;
  readonly viewIds: readonly string[];
  readonly activeViewId: string;
  readonly views: readonly WorkspaceCanvasView[];
}

/** An empty semantic workspace is the standard terminal presentation state. */
export interface StandardWorkspaceEmptyProjection {
  readonly kind: "empty";
}

/** A valid semantic document that is not yet representable by the standard UI. */
export interface StandardWorkspaceUnsupportedProjection {
  readonly kind: "unsupported";
  readonly reason: "split" | "floating" | "maximized";
}

export type StandardWorkspaceProjection =
  | StandardWorkspaceStackProjection
  | StandardWorkspaceEmptyProjection
  | StandardWorkspaceUnsupportedProjection;

export type StandardWorkspaceTabEvent =
  | { readonly kind: "select"; readonly instanceId: string }
  | { readonly kind: "close"; readonly instanceId: string };

function viewById(
  projection: WorkspaceCanvasProjection,
  instanceId: string,
): WorkspaceCanvasView {
  const view = projection.views.find((candidate) => candidate.instance.instanceId === instanceId);
  if (view === undefined) {
    throw new Error(`Semantic workspace stack references missing instance ${instanceId}.`);
  }
  return view;
}

/**
 * Project the renderer-neutral workspace into the subset the standard canvas
 * can display. It is deliberately data-only: no React, terminal store, or
 * renderer loader belongs at this boundary.
 */
export function createStandardWorkspaceProjection(
  projection: WorkspaceCanvasProjection,
): StandardWorkspaceProjection {
  const { document } = projection;
  if (document.root === null) return Object.freeze({ kind: "empty" });
  if (document.root.kind === "split") return Object.freeze({ kind: "unsupported", reason: "split" });
  if (document.floating.length > 0) return Object.freeze({ kind: "unsupported", reason: "floating" });
  if (document.maximizedStackId !== null) return Object.freeze({ kind: "unsupported", reason: "maximized" });

  const viewIds = Object.freeze([...document.root.instanceIds]);
  return Object.freeze({
    kind: "stack",
    stackId: document.root.stackId,
    viewIds,
    activeViewId: document.root.selectedInstanceId,
    views: Object.freeze(viewIds.map((instanceId) => viewById(projection, instanceId))),
  });
}

/**
 * Map a standard tab gesture to the same semantic canvas action as Layman.
 * Unsupported layouts deliberately expose no local action path.
 */
export function standardWorkspaceAction(
  projection: StandardWorkspaceProjection,
  event: StandardWorkspaceTabEvent,
): WorkspaceCanvasAction | null {
  if (projection.kind !== "stack") return null;
  const view = projection.views.find((candidate) => candidate.instance.instanceId === event.instanceId);
  if (view === undefined) return null;
  if (event.kind === "select") {
    if (event.instanceId === projection.activeViewId) return null;
    return Object.freeze({ kind: "select", instanceId: event.instanceId });
  }
  return view.closeable
    ? Object.freeze({ kind: "close", instanceId: event.instanceId })
    : null;
}
