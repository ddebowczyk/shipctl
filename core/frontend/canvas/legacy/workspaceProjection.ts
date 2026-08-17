import type {
  WorkspaceCanvasAction,
  WorkspaceCanvasProjection,
  WorkspaceCanvasView,
} from "@shipctl/core/workspace";

/** A legacy adapter can presently represent one root tab stack only. */
export interface LegacyWorkspaceStackProjection {
  readonly kind: "stack";
  readonly stackId: string;
  readonly viewIds: readonly string[];
  readonly activeViewId: string;
  readonly views: readonly WorkspaceCanvasView[];
}

/** A valid semantic document that is not yet representable by the legacy UI. */
export interface LegacyWorkspaceUnsupportedProjection {
  readonly kind: "unsupported";
  readonly reason: "empty" | "split" | "floating" | "maximized";
}

export type LegacyWorkspaceProjection =
  | LegacyWorkspaceStackProjection
  | LegacyWorkspaceUnsupportedProjection;

export type LegacyWorkspaceTabEvent =
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
 * Project the renderer-neutral workspace into the subset the legacy canvas
 * can display. It is deliberately data-only: no React, terminal store, or
 * renderer loader belongs at this boundary.
 */
export function createLegacyWorkspaceProjection(
  projection: WorkspaceCanvasProjection,
): LegacyWorkspaceProjection {
  const { document } = projection;
  if (document.root === null) return Object.freeze({ kind: "unsupported", reason: "empty" });
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
 * Map a legacy tab gesture to the same semantic canvas action as Layman.
 * Unsupported layouts deliberately expose no local action path.
 */
export function legacyWorkspaceAction(
  projection: LegacyWorkspaceProjection,
  event: LegacyWorkspaceTabEvent,
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
