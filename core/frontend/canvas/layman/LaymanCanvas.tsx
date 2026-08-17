import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  createLaymanController,
  createLaymanTab,
  createLaymanWindow,
  LaymanView,
  type LaymanComponents,
  type LaymanController,
  type LaymanInteractionPolicy,
  type LaymanPaneProps,
  type LaymanState,
  type LaymanTabProps,
} from "react-layman";

import type { LegacyCanvasProps } from "../legacy/LegacyCanvas.tsx";
import LegacyCanvas from "../legacy/LegacyCanvas.tsx";
import { GlobalSurfaceHost, PanelHost } from "@shipctl/core/host/views";
import {
  CURRENT_CANVAS_COMPATIBILITY_VIEW_TYPE_ID,
  type WorkspaceCanvas,
} from "@shipctl/core/workspace";
import type { ContributionId, ProjectRef } from "@shipctl/module-api";
import {
  createLaymanWorkspaceState,
  type LaymanCanvasPaneData,
  workspaceStackIdFromLaymanWindowId,
} from "./workspaceProjection.ts";
import { laymanWorkspaceAction } from "./workspaceActions.ts";

export type {
  LaymanCanvasPaneData,
  LaymanLegacyCanvasPaneData,
  LaymanWorkspaceViewPaneData,
} from "./workspaceProjection.ts";

export const LAYMAN_CANVAS_WINDOW_ID = "shipctl.canvas.window";
export const LAYMAN_CANVAS_TAB_ID = "shipctl.canvas.tab";
/** The stable host-owned persistence key for this initial workspace. */
export const LAYMAN_CANVAS_WORKSPACE_ID = "shipctl.canvas";
/** Verified upstream revision for the approved GitHub source dependency. */
export const LAYMAN_SOURCE_REVISION = "8d0c41a0a52830f3072771af674d63d80215384e";

const LAYMAN_CANVAS_VIEW = {
  viewId: "shipctl.canvas",
  ariaLabel: "Shipctl canvas",
  showTabs: true,
} as const;

const LAYMAN_CANVAS_VIEW_STYLE = {
  width: "var(--shipctl-layman-canvas-width, 100%)",
  height: "var(--shipctl-layman-canvas-height, 100%)",
} as const;

const LAYMAN_CANVAS_INTERACTION: LaymanInteractionPolicy<LaymanCanvasPaneData> = {
  canExecute({ command, inspection, origin }) {
    if (origin !== "user") return { kind: "allow" };
    if (command.type === "tab.select") return { kind: "allow" };
    if (command.type === "tab.remove") {
      const tab = inspection.windows
        .flatMap((window) => window.tabs)
        .find((candidate) => candidate.id === command.tabId);
      if (tab?.data.kind === "shipctl.workspace-view" && tab.data.closeable) {
        return { kind: "allow" };
      }
    }
    if (
      command.type === "tab.move"
      && command.target.kind === "window"
      && command.placement === "center"
      && workspaceStackIdFromLaymanWindowId(command.target.windowId) !== null
    ) {
      const targetWindowId = command.target.windowId;
      const source = inspection.windows.find((window) => (
        window.tabs.some((tab) => tab.id === command.tabId)
      ));
      const target = inspection.windows.find((window) => window.id === targetWindowId);
      const sourceTab = source?.tabs.find((tab) => tab.id === command.tabId);
      if (
        source?.location === "tiled"
        && target?.location === "tiled"
        && sourceTab?.data.kind === "shipctl.workspace-view"
      ) {
        return { kind: "allow" };
      }
    }
    return {
      kind: "deny",
      reason: "This workspace action is not available from the canvas yet.",
    };
  },
};

const LegacyCanvasContext = createContext<LegacyCanvasProps | null>(null);
const WorkspaceCanvasContext = createContext<WorkspaceCanvas | undefined>(undefined);

function closeWorkspaceView(workspace: WorkspaceCanvas, instanceId: string): void {
  void workspace.execute({ kind: "close", instanceId }).catch(() => undefined);
}

function projectFor(
  legacyCanvasProps: LegacyCanvasProps,
  projectId: string | null,
): ProjectRef | null {
  if (projectId === null) return null;
  const repo = legacyCanvasProps.model.sidebar.repos.find((candidate) => candidate.path === projectId);
  return {
    id: projectId,
    name: repo?.name ?? projectId.split("/").filter(Boolean).pop() ?? "Project",
    path: projectId,
    groupId: repo?.group ?? null,
  };
}

function WorkspacePaneUnavailable({
  viewTypeId,
  close,
}: {
  readonly viewTypeId: string;
  readonly close: (() => void) | undefined;
}) {
  return (
    <div className="panel-host__unavailable" role="alert">
      <strong>Workspace view unavailable</strong>
      <span>{viewTypeId} is not available in the accepted runtime.</span>
      {close && <button className="btn-ghost" onClick={close}>Close view</button>}
    </div>
  );
}

function LaymanCanvasPane({ tab, selected }: LaymanPaneProps<LaymanCanvasPaneData>) {
  const legacyCanvasProps = useContext(LegacyCanvasContext);
  const workspace = useContext(WorkspaceCanvasContext);

  if (!legacyCanvasProps) {
    throw new Error("LaymanCanvasPane must be rendered inside LaymanCanvas.");
  }
  if (tab.data.kind === "shipctl.legacy-canvas") {
    return <LegacyCanvas {...legacyCanvasProps} />;
  }
  const pane = tab.data;
  if (pane.viewTypeId === CURRENT_CANVAS_COMPATIBILITY_VIEW_TYPE_ID) {
    return <LegacyCanvas {...legacyCanvasProps} />;
  }
  const close = workspace && pane.closeable
    ? () => closeWorkspaceView(workspace, pane.instanceId)
    : undefined;
  if (pane.availability === "missing-definition") {
    return <WorkspacePaneUnavailable viewTypeId={pane.viewTypeId} close={close} />;
  }
  const contributionId = pane.viewTypeId as ContributionId;
  const globalSurface = legacyCanvasProps.ports.surfaceCatalog.globalSurface(contributionId);
  if (globalSurface) {
    return (
      <GlobalSurfaceHost
        contribution={globalSurface}
        surfaceId={globalSurface.id}
        close={close ?? (() => undefined)}
        projectPaths={legacyCanvasProps.ports.projectPaths}
        services={legacyCanvasProps.ports.moduleHostServices}
        moduleActivations={legacyCanvasProps.ports.moduleActivations}
      />
    );
  }
  const panel = legacyCanvasProps.ports.surfaceCatalog.panel(contributionId);
  if (panel) {
    const view = workspace?.projection.views.find((candidate) => (
      candidate.instance.instanceId === pane.instanceId
    ));
    const resource = view?.instance.resource;
    const projectId = resource?.kind === "project"
      ? resource.projectId
      : resource?.kind === "panel" ? resource.projectId : null;
    return (
      <PanelHost
        contribution={panel}
        panelId={panel.id}
        instanceId={pane.instanceId}
        project={projectFor(legacyCanvasProps, projectId)}
        visible={selected}
        close={close ?? (() => undefined)}
        // Workspace labels are semantic document data. A title command is not
        // in this initial renderer action subset, so panes cannot alter it.
        setTitle={() => undefined}
        services={legacyCanvasProps.ports.moduleHostServices}
        moduleActivations={legacyCanvasProps.ports.moduleActivations}
      />
    );
  }

  return <WorkspacePaneUnavailable viewTypeId={pane.viewTypeId} close={close} />;
}

function LaymanCanvasTab({ tab }: LaymanTabProps<LaymanCanvasPaneData>) {
  return <span>{tab.title}</span>;
}

const LAYMAN_CANVAS_COMPONENTS: LaymanComponents<LaymanCanvasPaneData> = {
  Pane: LaymanCanvasPane,
  Tab: LaymanCanvasTab,
};

/** The deterministic, one-window state used until layout persistence exists. */
export function createLaymanCanvasState(): LaymanState<LaymanCanvasPaneData> {
  const tab = createLaymanTab<LaymanCanvasPaneData>(
    "Shipctl",
    { kind: "shipctl.legacy-canvas" },
    LAYMAN_CANVAS_TAB_ID,
  );

  return {
    layout: createLaymanWindow([tab], LAYMAN_CANVAS_WINDOW_ID, LAYMAN_CANVAS_TAB_ID),
    floatingWindows: [],
  };
}

/**
 * Creates the controlled workspace used by this proof adapter.
 *
 * Host commands restore canonical semantic state. User commands may select a
 * tab, close a closeable semantic view, or move a tab into the centre of an
 * existing tiled semantic stack. Other layout-edit commands remain denied
 * until matching semantic workspace commands are exposed.
 */
export function createLaymanCanvasController(
  state: LaymanState<LaymanCanvasPaneData> = createLaymanCanvasState(),
): LaymanController<LaymanCanvasPaneData> {
  return createLaymanController({
    state,
    interaction: LAYMAN_CANVAS_INTERACTION,
  });
}

/**
 * Updates CSS dimensions on the Layman root without changing canvas or
 * terminal state. The public Layman view owns its own geometry calculations;
 * this adapter owns the host-container observation boundary.
 */
function useLaymanCanvasDimensions() {
  const [hostElement, setHostElement] = useState<HTMLDivElement | null>(null);
  const setHost = useCallback((element: HTMLDivElement | null) => {
    setHostElement(element);
  }, []);

  useLayoutEffect(() => {
    if (!hostElement) return undefined;

    const updateDimensions = () => {
      const { width, height } = hostElement.getBoundingClientRect();
      hostElement.style.setProperty("--shipctl-layman-canvas-width", `${width}px`);
      hostElement.style.setProperty("--shipctl-layman-canvas-height", `${height}px`);
    };

    updateDimensions();
    if (typeof ResizeObserver === "undefined") return undefined;

    const observer = new ResizeObserver(updateDimensions);
    observer.observe(hostElement);

    return () => observer.disconnect();
  }, [hostElement]);

  return setHost;
}

export interface LaymanCanvasProps extends LegacyCanvasProps {
  /** Test-only injection point for a controlled public Layman controller. */
  readonly controller?: LaymanController<LaymanCanvasPaneData>;
}

function workspaceTransition(
  transition: Parameters<typeof laymanWorkspaceAction>[0],
  workspace: WorkspaceCanvas,
): void {
  const action = laymanWorkspaceAction(transition);
  if (action) void workspace.execute(action).catch(() => undefined);
}

/**
 * Experimental main-canvas adapter. It preserves the full legacy DOM inside
 * one Layman pane. A host runtime may inject a persistence-backed controller;
 * this renderer never reads host configuration or transport state.
 */
export default function LaymanCanvas({ controller, workspace, ...legacyCanvasProps }: LaymanCanvasProps) {
  const ownedController = useRef<LaymanController<LaymanCanvasPaneData> | null>(null);
  const setHost = useLaymanCanvasDimensions();

  if (!controller && !ownedController.current) {
    ownedController.current = createLaymanCanvasController(
      workspace ? createLaymanWorkspaceState(workspace.projection) : createLaymanCanvasState(),
    );
  }

  const resolvedController = controller ?? ownedController.current;
  if (!resolvedController) {
    throw new Error("LaymanCanvas requires a controller.");
  }

  useLayoutEffect(() => {
    if (!workspace) return;
    resolvedController.replaceState(createLaymanWorkspaceState(workspace.projection), { origin: "host" });
  }, [resolvedController, workspace]);

  useEffect(() => {
    if (!workspace) return undefined;
    return resolvedController.subscribe((transition) => workspaceTransition(transition, workspace));
  }, [resolvedController, workspace]);

  return (
    <LegacyCanvasContext.Provider value={legacyCanvasProps}>
      <WorkspaceCanvasContext.Provider value={workspace}>
        <div
          ref={setHost}
          className="canvas-layman"
          style={{ position: "relative", height: "100%", minHeight: 0, minWidth: 0 }}
          data-canvas-adapter="layman"
        >
          <LaymanView
            controller={resolvedController}
            config={LAYMAN_CANVAS_VIEW}
            components={LAYMAN_CANVAS_COMPONENTS}
            style={LAYMAN_CANVAS_VIEW_STYLE}
          />
        </div>
      </WorkspaceCanvasContext.Provider>
    </LegacyCanvasContext.Provider>
  );
}
