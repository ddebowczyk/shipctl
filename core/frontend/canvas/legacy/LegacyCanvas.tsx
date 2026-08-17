import {
  GlobalSurfaceHost,
  ModuleProjectLayoutSurfaces,
  PanelHost,
} from "@shipctl/core/host/views";
import { CURRENT_CANVAS_COMPATIBILITY_VIEW_TYPE_ID } from "@shipctl/core/workspace";
import type { WorkspaceCanvasView } from "@shipctl/core/workspace";
import type { ContributionId, ProjectRef } from "@shipctl/module-api";
import {
  TerminalErrorBoundary,
  TerminalSlot,
} from "@shipctl/core/terminal-host/views";

import type { CanvasAdapterProps } from "../adapterTypes.ts";
import type {
  CanvasGlobalSurfaceRendererProps,
  CanvasPanelRendererProps,
  CanvasSidebarRendererProps,
  CanvasTabBarRendererProps,
  CanvasTerminalRendererProps,
  CanvasTrailingLayoutRendererProps,
  CanvasViewPorts,
} from "../viewPorts.ts";
import LegacySidebar from "./LegacySidebar.tsx";
import LegacyTabBar from "./LegacyTabBar.tsx";
import {
  createLegacyWorkspaceProjection,
  legacyWorkspaceAction,
} from "./workspaceProjection.ts";

import "./legacyCanvas.css";

function DefaultSidebar({ sidebar, actions, ports }: CanvasSidebarRendererProps) {
  return (
    <LegacySidebar
      repos={sidebar.repos}
      groups={sidebar.groups}
      activeRepoPath={sidebar.activeProjectPath}
      activeTabId={sidebar.activeTabId}
      activeGlobalSurfaceId={sidebar.activeGlobalSurfaceId}
      onSelectRepo={actions.selectRepo}
      onAddProject={actions.addProject}
      onRemoveProject={actions.removeProject}
      onNewModuleSession={actions.newModuleSession}
      onOpenInEditor={actions.openInEditor}
      onSelectTab={actions.selectTab}
      onSelectProjectTab={actions.selectProjectTab}
      onCloseTab={actions.closeTab}
      onMoveTab={actions.moveTab}
      onNewShell={actions.newDefaultTerminal}
      onRenameGroup={actions.renameGroup}
      onDeleteGroup={actions.deleteGroup}
      onMoveToGroup={actions.moveToGroup}
      onToggleGlobalSurface={actions.toggleGlobalSurface}
      tabDropProjectPath={sidebar.tabDropProjectPath}
      globalNavigation={sidebar.globalNavigation}
      sidebarContributions={ports.surfaceCatalog.sidebar()}
      projectNavigationContributions={ports.surfaceCatalog.projectNavigation()}
      moduleActivations={ports.moduleActivations}
    />
  );
}

function DefaultTabBar({
  tabBar,
  activeProjectPath,
  globalSurfaceOpen,
  actions,
}: CanvasTabBarRendererProps) {
  return (
    <LegacyTabBar
      onClose={actions.closeTab}
      onSelectTab={actions.selectTab}
      onNewTerminal={actions.newTerminal}
      panels={tabBar.panels}
      onOpenPanel={actions.openPanel}
      onOpenInEditor={() => {
        if (activeProjectPath) void actions.openInEditor(activeProjectPath);
      }}
      onRenameTab={actions.renameTab}
      onMoveTab={actions.moveTab}
      onDragProjectChange={actions.setTabDropProjectPath}
      globalSurfaceOpen={globalSurfaceOpen}
    />
  );
}

function DefaultGlobalSurface({
  surfaceId,
  close,
  ports,
}: CanvasGlobalSurfaceRendererProps) {
  return (
    <GlobalSurfaceHost
      contribution={ports.surfaceCatalog.globalSurface(surfaceId)}
      surfaceId={surfaceId}
      close={close}
      projectPaths={ports.projectPaths}
      services={ports.moduleHostServices}
      moduleActivations={ports.moduleActivations}
    />
  );
}

function DefaultPanel({
  content,
  close,
  setTitle,
  ports,
}: CanvasPanelRendererProps) {
  return (
    <PanelHost
      contribution={ports.surfaceCatalog.panel(content.panelId)}
      panelId={content.panelId}
      instanceId={content.instanceId}
      project={content.project}
      visible
      close={close}
      setTitle={setTitle}
      services={ports.moduleHostServices}
      moduleActivations={ports.moduleActivations}
    />
  );
}

function DefaultTerminal({ slot, ports }: CanvasTerminalRendererProps) {
  return (
    <TerminalErrorBoundary>
      <TerminalSlot
        descriptor={slot.descriptor}
        registry={ports.terminalPresentationRegistry}
        moduleActivations={ports.moduleActivations}
        services={ports.moduleHostServices}
        visible={slot.visible}
      />
    </TerminalErrorBoundary>
  );
}

function DefaultTrailingLayout({ project, ports }: CanvasTrailingLayoutRendererProps) {
  return (
    <ModuleProjectLayoutSurfaces
      contributions={ports.surfaceCatalog.projectLayout("workspace.trailing")}
      project={project}
      moduleActivations={ports.moduleActivations}
    />
  );
}

const DEFAULT_VIEW_PORTS: CanvasViewPorts = {
  Sidebar: DefaultSidebar,
  TabBar: DefaultTabBar,
  GlobalSurface: DefaultGlobalSurface,
  Panel: DefaultPanel,
  Terminal: DefaultTerminal,
  TrailingLayout: DefaultTrailingLayout,
};

export interface LegacyCanvasProps extends CanvasAdapterProps {}

function projectFor(model: CanvasAdapterProps["model"], view: WorkspaceCanvasView): ProjectRef | null {
  const { resource } = view.instance;
  const projectId = resource.kind === "project"
    ? resource.projectId
    : resource.kind === "panel" ? resource.projectId : null;
  if (projectId === null) return null;
  const repo = model.sidebar.repos.find((candidate) => candidate.path === projectId);
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

function WorkspaceLayoutUnavailable({
  reason,
}: {
  readonly reason: "empty" | "split" | "floating" | "maximized";
}) {
  return (
    <div className="panel-host__unavailable" role="alert">
      <strong>Workspace layout unavailable</strong>
      <span>The legacy canvas cannot display this semantic workspace layout ({reason}).</span>
    </div>
  );
}

/** Today's layout adapter. It receives facts and actions; the shell owns policy. */
export default function LegacyCanvas({
  model,
  actions,
  ports,
  viewPorts,
  workspace,
}: LegacyCanvasProps) {
  const renderers: CanvasViewPorts = { ...DEFAULT_VIEW_PORTS, ...viewPorts };
  const { Sidebar, TabBar, GlobalSurface, Panel, Terminal, TrailingLayout } = renderers;
  const semanticWorkspace = workspace
    ? createLegacyWorkspaceProjection(workspace.projection)
    : undefined;
  const semanticView = semanticWorkspace?.kind === "stack"
    ? semanticWorkspace.views.find((view) => view.instance.instanceId === semanticWorkspace.activeViewId)
    : undefined;
  const semanticContent = semanticView?.instance.viewTypeId === CURRENT_CANVAS_COMPATIBILITY_VIEW_TYPE_ID
    ? undefined
    : semanticView;
  const unsupportedSemanticLayout = semanticWorkspace?.kind === "unsupported"
    ? semanticWorkspace
    : undefined;
  const semanticGlobalSurface = semanticContent === undefined
    ? undefined
    : ports.surfaceCatalog.globalSurface(semanticContent.instance.viewTypeId as ContributionId);
  const semanticPanel = semanticContent === undefined
    ? undefined
    : ports.surfaceCatalog.panel(semanticContent.instance.viewTypeId as ContributionId);
  const semanticAction = semanticWorkspace && semanticContent && workspace
    ? (event: { readonly kind: "close"; readonly instanceId: string }) => {
        const action = legacyWorkspaceAction(semanticWorkspace, event);
        if (action) void workspace.execute(action).catch(() => undefined);
      }
    : undefined;
  const closeSemanticView = semanticContent?.closeable && semanticAction
    ? () => semanticAction({ kind: "close", instanceId: semanticContent.instance.instanceId })
    : undefined;
  const semanticPresentationActive = semanticContent !== undefined || unsupportedSemanticLayout !== undefined;
  const content = semanticPresentationActive ? null : model.content;
  const panelContent = content?.kind === "panel" ? content : null;
  const sidebar = semanticPresentationActive
    ? {
        ...model.sidebar,
        activeTabId: null,
        activeGlobalSurfaceId: semanticGlobalSurface?.id ?? null,
      }
    : model.sidebar;
  const globalSurfaceOpen = semanticPresentationActive || content?.kind === "global-surface";

  return (
    <div className="app-shell__frame">
      {sidebar.visible && <Sidebar sidebar={sidebar} actions={actions} ports={ports} />}

      <div className="workspace-panel">
        <TabBar
          tabBar={model.tabBar}
          activeProjectPath={sidebar.activeProjectPath}
          globalSurfaceOpen={globalSurfaceOpen}
          actions={actions}
        />

        <div className="terminal-stage">
          {semanticGlobalSurface && semanticContent && (
            <GlobalSurface
              surfaceId={semanticGlobalSurface.id}
              close={closeSemanticView ?? (() => undefined)}
              ports={ports}
            />
          )}
          {semanticPanel && semanticContent && (
            <Panel
              content={{
                kind: "panel",
                panelId: semanticPanel.id,
                instanceId: semanticContent.instance.instanceId,
                project: projectFor(model, semanticContent),
              }}
              close={closeSemanticView ?? (() => undefined)}
              // Semantic view labels are document data. A title command is
              // not in the current adapter action subset.
              setTitle={() => undefined}
              ports={ports}
            />
          )}
          {semanticContent && !semanticGlobalSurface && !semanticPanel && (
            <WorkspaceViewUnavailable view={semanticContent} close={closeSemanticView} />
          )}
          {unsupportedSemanticLayout && (
            <WorkspaceLayoutUnavailable reason={unsupportedSemanticLayout.reason} />
          )}
          {content?.kind === "global-surface" && (
            <GlobalSurface
              surfaceId={content.surfaceId}
              close={actions.closeGlobalSurface}
              ports={ports}
            />
          )}
          {panelContent && (
            <Panel
              content={panelContent}
              close={() => actions.closeTab(panelContent.instanceId)}
              setTitle={(title) => actions.setTabTitle(panelContent.instanceId, title)}
              ports={ports}
            />
          )}
          {content?.kind === "empty" && (
            <div className="terminal-empty">{content.message}</div>
          )}
          {model.terminalSlots.map((slot) => (
            <div
              key={slot.key}
              className="absolute inset-0"
              style={{ display: slot.visible && !semanticPresentationActive ? "block" : "none" }}
            >
              <Terminal slot={{ ...slot, visible: slot.visible && !semanticPresentationActive }} ports={ports} />
            </div>
          ))}
        </div>
      </div>

      {model.trailingLayout.visible && model.trailingLayout.project && (
        <TrailingLayout project={model.trailingLayout.project} ports={ports} />
      )}
    </div>
  );
}
