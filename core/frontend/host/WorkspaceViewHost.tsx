import { useCallback, useMemo } from "react";
import type { ProjectRef } from "@shipctl/module-api";
import { useRepoStore } from "@shipctl/core/projects";
import type {
  WorkspaceCanvas,
  WorkspaceCanvasView,
} from "@shipctl/core/workspace";

import { useAcceptedWorkspaceContributionRuntime } from "./AcceptedWorkspaceContributionRuntime.tsx";
import GlobalSurfaceHost from "./GlobalSurfaceHost.tsx";
import PanelHost from "./PanelHost.tsx";

function projectFor(
  view: WorkspaceCanvasView,
  repos: readonly { readonly path: string; readonly name: string; readonly group: string | null }[],
): ProjectRef | null {
  const { resource } = view.instance;
  const projectId = resource.kind === "project"
    ? resource.projectId
    : resource.kind === "panel" ? resource.projectId : null;
  if (projectId === null) return null;
  const repo = repos.find((candidate) => candidate.path === projectId);
  return {
    id: projectId,
    name: repo?.name ?? projectId.split("/").filter(Boolean).pop() ?? "Project",
    path: projectId,
    groupId: repo?.group ?? null,
  };
}

function WorkspaceViewUnavailable({
  view,
  close,
}: {
  readonly view: WorkspaceCanvasView;
  readonly close: (() => void) | undefined;
}) {
  return (
    <div className="panel-host__unavailable" role="alert">
      <strong>Workspace view unavailable</strong>
      <span>{view.instance.viewTypeId} is not available in the accepted runtime.</span>
      {close && <button className="btn-ghost" onClick={close}>Close view</button>}
    </div>
  );
}

export interface WorkspaceViewHostProps {
  readonly workspace: WorkspaceCanvas | undefined;
  readonly view: WorkspaceCanvasView;
  readonly visible?: boolean;
}

/** Render one admitted semantic workspace instance through host-owned ports. */
export default function WorkspaceViewHost({
  workspace,
  view,
  visible = true,
}: WorkspaceViewHostProps) {
  const { catalog } = useAcceptedWorkspaceContributionRuntime();
  const repos = useRepoStore((state) => state.repos);
  const renderer = catalog.renderer(view.instance.viewTypeId);
  const project = useMemo(() => projectFor(view, repos), [repos, view]);
  const close = useCallback(() => {
    if (!workspace || !view.closeable) return;
    void workspace.execute({ kind: "close", instanceId: view.instance.instanceId }).catch(() => undefined);
  }, [view.closeable, view.instance.instanceId, workspace]);
  const setTitle = useCallback((label: string | null) => {
    if (!workspace) return;
    const normalizedLabel = label?.trim() || null;
    void workspace.execute({
      kind: "rename",
      instanceId: view.instance.instanceId,
      label: normalizedLabel,
    }).catch(() => undefined);
  }, [view.instance.instanceId, workspace]);
  const closeView = view.closeable ? close : undefined;

  if (renderer?.kind === "global-surface") {
    return <GlobalSurfaceHost surfaceId={renderer.surface.id} close={closeView ?? (() => undefined)} />;
  }
  if (renderer?.kind === "panel") {
    return (
      <PanelHost
        panelId={renderer.surface.id}
        instanceId={view.instance.instanceId}
        project={project}
        visible={visible}
        close={closeView ?? (() => undefined)}
        setTitle={setTitle}
      />
    );
  }

  return <WorkspaceViewUnavailable view={view} close={closeView} />;
}
