import type { WorkspaceCanvas } from "./canvasBridge.ts";

/** One semantic workspace view projected into the host's project-panel tab row. */
export interface WorkspaceTabProjection {
  readonly id: string;
  readonly label: string;
  readonly viewTypeId: string;
  readonly selected: boolean;
  readonly closeable: boolean;
}

/**
 * A single tiled stack needs no renderer-owned tab strip. More complex Layman
 * layouts keep their local chrome because each stack has its own selection.
 */
export function projectSingleStackWorkspaceTabs(
  canvas: WorkspaceCanvas | undefined,
): readonly WorkspaceTabProjection[] {
  const document = canvas?.projection.document;
  if (!canvas || document?.root?.kind !== "stack" || document.floating.length > 0) return [];
  const views = new Map(
    canvas.projection.views.map((view) => [view.instance.instanceId, view]),
  );
  return document.root.instanceIds.flatMap((instanceId) => {
    const view = views.get(instanceId);
    return view === undefined ? [] : [{
      id: instanceId,
      label: view.title,
      viewTypeId: view.instance.viewTypeId,
      selected: document.root?.kind === "stack"
        && document.root.selectedInstanceId === instanceId,
      closeable: view.closeable,
    }];
  });
}

export function workspaceNeedsInternalTabStrip(
  canvas: WorkspaceCanvas | undefined,
): boolean {
  const document = canvas?.projection.document;
  if (!document || document.root === null) return false;
  return document.root.kind !== "stack" || document.floating.length > 0;
}
