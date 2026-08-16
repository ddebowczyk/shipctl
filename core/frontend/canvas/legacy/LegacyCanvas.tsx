import {
  GlobalSurfaceHost,
  ModuleProjectLayoutSurfaces,
  PanelHost,
} from "@shipctl/core/host/views";
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
  actions,
}: CanvasTabBarRendererProps) {
  return (
    <LegacyTabBar
      onClose={actions.closeTab}
      onNewTerminal={actions.newTerminal}
      panels={tabBar.panels}
      onOpenPanel={actions.openPanel}
      onOpenInEditor={() => {
        if (activeProjectPath) void actions.openInEditor(activeProjectPath);
      }}
      onRenameTab={actions.renameTab}
      onMoveTab={actions.moveTab}
      onDragProjectChange={actions.setTabDropProjectPath}
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

/** Today's layout adapter. It receives facts and actions; the shell owns policy. */
export default function LegacyCanvas({
  model,
  actions,
  ports,
  viewPorts,
}: LegacyCanvasProps) {
  const renderers: CanvasViewPorts = { ...DEFAULT_VIEW_PORTS, ...viewPorts };
  const { Sidebar, TabBar, GlobalSurface, Panel, Terminal, TrailingLayout } = renderers;
  const panelContent = model.content.kind === "panel" ? model.content : null;

  return (
    <div className="app-shell__frame">
      {model.sidebar.visible && <Sidebar sidebar={model.sidebar} actions={actions} ports={ports} />}

      <div className="workspace-panel">
        <TabBar
          tabBar={model.tabBar}
          activeProjectPath={model.sidebar.activeProjectPath}
          actions={actions}
        />

        <div className="terminal-stage">
          {model.content.kind === "global-surface" && (
            <GlobalSurface
              surfaceId={model.content.surfaceId}
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
          {model.content.kind === "empty" && (
            <div className="terminal-empty">{model.content.message}</div>
          )}
          {model.terminalSlots.map((slot) => (
            <div
              key={slot.key}
              className="absolute inset-0"
              style={{ display: slot.visible ? "block" : "none" }}
            >
              <Terminal slot={slot} ports={ports} />
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
