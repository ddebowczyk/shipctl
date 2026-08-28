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
  LaymanView,
  type LaymanComponents,
  type LaymanController,
  type LaymanInteractionPolicy,
  type LaymanPaneProps,
  type LaymanState,
  type LaymanTabProps,
} from "react-layman";
import "react-layman/styles.css";

import { WorkspaceViewHost } from "@shipctl/core/host/views";
import { TerminalStage } from "@shipctl/core/terminal-host/views";
import {
  selectedWorkspaceInstanceIds,
  type WorkspaceCanvas,
} from "@shipctl/core/workspace";

import type { CanvasAdapterProps } from "../adapterTypes.ts";
import {
  createLaymanWorkspaceState,
  type LaymanCanvasPaneData,
  workspaceStackIdFromLaymanWindowId,
} from "./workspaceProjection.ts";
import { laymanWorkspaceAction } from "./workspaceActions.ts";

export type {
  LaymanCanvasPaneData,
  LaymanWorkspaceViewPaneData,
} from "./workspaceProjection.ts";

/** Stable host-owned persistence key used by the Layman workspace bridge. */
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
    if (command.type === "tab.move" && command.target.kind === "window") {
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
        && workspaceStackIdFromLaymanWindowId(targetWindowId) !== null
      ) {
        if (command.placement === "center") return { kind: "allow" };
        if (
          sourceTab.data.splitAllowed
          && (command.placement === "top"
            || command.placement === "bottom"
            || command.placement === "left"
            || command.placement === "right")
          && !(source.id === target.id && source.tabs.length === 1)
        ) {
          return { kind: "allow" };
        }
      }
    }
    return {
      kind: "deny",
      reason: "This workspace action is not available from the canvas yet.",
    };
  },
};

const WorkspaceCanvasContext = createContext<WorkspaceCanvas | undefined>(undefined);

function WorkspacePaneUnavailable({
  viewTypeId,
}: {
  readonly viewTypeId: string;
}) {
  return (
    <div className="panel-host__unavailable" role="alert">
      <strong>Workspace view unavailable</strong>
      <span>{viewTypeId} is not available in the accepted runtime.</span>
    </div>
  );
}

function LaymanCanvasPane({ tab, selected }: LaymanPaneProps<LaymanCanvasPaneData>) {
  const workspace = useContext(WorkspaceCanvasContext);

  const pane = tab.data;
  const view = workspace?.projection.views.find((candidate) => (
    candidate.instance.instanceId === pane.instanceId
  ));
  if (!workspace || !view) {
    return <WorkspacePaneUnavailable viewTypeId={pane.viewTypeId} />;
  }
  return <WorkspaceViewHost workspace={workspace} view={view} visible={selected} />;
}

function LaymanCanvasTab({ tab }: LaymanTabProps<LaymanCanvasPaneData>) {
  return <span>{tab.title}</span>;
}

const LAYMAN_CANVAS_COMPONENTS: LaymanComponents<LaymanCanvasPaneData> = {
  Pane: LaymanCanvasPane,
  Tab: LaymanCanvasTab,
};

/** Empty semantic workspace state used until the workspace bridge provides a document. */
export function createLaymanCanvasState(): LaymanState<LaymanCanvasPaneData> {
  return {
    layout: undefined,
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

export interface LaymanCanvasProps extends CanvasAdapterProps {
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

function hasSelectedSemanticView(workspace: WorkspaceCanvas | undefined): boolean {
  if (!workspace) return false;
  const selected = new Set(selectedWorkspaceInstanceIds(workspace.projection.document));
  return workspace.projection.views.some((view) => (
    selected.has(view.instance.instanceId)
  ));
}

/**
 * Experimental renderer for the same semantic document as the standard
 * adapter. The terminal stage is mount-stable while admitted views render as
 * their own semantic workspace panes.
 */
export default function LaymanCanvas({ controller, workspace }: LaymanCanvasProps) {
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

  const semanticViewSelected = hasSelectedSemanticView(workspace);

  return (
    <WorkspaceCanvasContext.Provider value={workspace}>
      <div
        ref={setHost}
        className="canvas-layman"
        style={{ position: "relative", height: "100%", minHeight: 0, minWidth: 0 }}
        data-canvas-adapter="layman"
      >
        <div className="absolute inset-0" style={{ display: semanticViewSelected ? "none" : "block" }}>
          <TerminalStage visible={!semanticViewSelected} />
        </div>
        <div className="absolute inset-0" style={{ display: semanticViewSelected ? "block" : "none" }}>
          <LaymanView
            controller={resolvedController}
            config={LAYMAN_CANVAS_VIEW}
            components={LAYMAN_CANVAS_COMPONENTS}
            style={LAYMAN_CANVAS_VIEW_STYLE}
          />
        </div>
      </div>
    </WorkspaceCanvasContext.Provider>
  );
}
