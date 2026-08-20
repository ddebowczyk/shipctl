import { WorkspaceViewHost } from "@shipctl/core/host/views";
import { TerminalStage } from "@shipctl/core/terminal-host/views";

import type { CanvasAdapterProps } from "../adapterTypes.ts";
import { createStandardWorkspaceProjection } from "./workspaceProjection.ts";

export interface StandardWorkspaceCanvasProps extends CanvasAdapterProps {}

function WorkspaceLayoutUnavailable({
  reason,
}: {
  readonly reason: "split" | "floating" | "maximized";
}) {
  return (
    <div className="panel-host__unavailable" role="alert">
      <strong>Workspace layout unavailable</strong>
      <span>The standard renderer cannot display this semantic workspace layout ({reason}).</span>
    </div>
  );
}

/**
 * Standard renderer for the semantic one-stack workspace profile.
 *
 * It owns no feature model, callbacks, service bag, activation map, or
 * terminal inventory. Those are now respectively workspace document data,
 * host-owned services, and the terminal stage runtime.
 */
export default function StandardWorkspaceCanvas({ workspace }: StandardWorkspaceCanvasProps) {
  const projection = workspace
    ? createStandardWorkspaceProjection(workspace.projection)
    : undefined;
  const selectedView = projection?.kind === "stack"
    ? projection.views.find((view) => view.instance.instanceId === projection.activeViewId)
    : undefined;
  const unsupported = projection?.kind === "unsupported" ? projection : undefined;

  return (
    <>
      <TerminalStage visible={workspace === undefined || projection?.kind === "empty"} />
      {unsupported && <WorkspaceLayoutUnavailable reason={unsupported.reason} />}
      {selectedView && (
        <div className="absolute inset-0 min-h-0 min-w-0" data-workspace-view={selectedView.instance.viewTypeId}>
          <WorkspaceViewHost workspace={workspace} view={selectedView} />
        </div>
      )}
    </>
  );
}
