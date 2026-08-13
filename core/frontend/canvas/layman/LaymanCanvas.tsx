import {
  createContext,
  useCallback,
  useContext,
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

export const LAYMAN_CANVAS_WINDOW_ID = "shipctl.canvas.window";
export const LAYMAN_CANVAS_TAB_ID = "shipctl.canvas.tab";
/** The stable host-owned persistence key for this initial workspace. */
export const LAYMAN_CANVAS_WORKSPACE_ID = "shipctl.canvas";
/** Verified upstream revision for the approved GitHub source dependency. */
export const LAYMAN_SOURCE_REVISION = "8d0c41a0a52830f3072771af674d63d80215384e";

export interface LaymanCanvasPaneData {
  readonly kind: "shipctl.legacy-canvas";
}

const LAYMAN_CANVAS_VIEW = {
  viewId: "shipctl.canvas",
  ariaLabel: "Shipctl canvas",
  maxDepth: 0,
  showTabs: false,
} as const;

const LAYMAN_CANVAS_VIEW_STYLE = {
  width: "var(--shipctl-layman-canvas-width, 100%)",
  height: "var(--shipctl-layman-canvas-height, 100%)",
} as const;

const LAYMAN_CANVAS_INTERACTION: LaymanInteractionPolicy<LaymanCanvasPaneData> = {
  canExecute({ origin }) {
    if (origin === "user") {
      return {
        kind: "deny",
        reason: "The Shipctl canvas layout is not user configurable yet.",
      };
    }

    return { kind: "allow" };
  },
};

const LegacyCanvasContext = createContext<LegacyCanvasProps | null>(null);

function LaymanCanvasPane({ tab }: LaymanPaneProps<LaymanCanvasPaneData>) {
  const legacyCanvasProps = useContext(LegacyCanvasContext);

  if (!legacyCanvasProps) {
    throw new Error("LaymanCanvasPane must be rendered inside LaymanCanvas.");
  }
  if (tab.data.kind !== "shipctl.legacy-canvas") {
    return null;
  }

  return <LegacyCanvas {...legacyCanvasProps} />;
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
 * Host commands remain available for test and future bootstrap wiring. User
 * commands are denied until Shipctl intentionally exposes layout controls.
 */
export function createLaymanCanvasController(): LaymanController<LaymanCanvasPaneData> {
  return createLaymanController({
    state: createLaymanCanvasState(),
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

/**
 * Experimental main-canvas adapter. It preserves the full legacy DOM inside
 * one Layman pane. A host runtime may inject a persistence-backed controller;
 * this renderer never reads host configuration or transport state.
 */
export default function LaymanCanvas({ controller, ...legacyCanvasProps }: LaymanCanvasProps) {
  const ownedController = useRef<LaymanController<LaymanCanvasPaneData> | null>(null);
  const setHost = useLaymanCanvasDimensions();

  if (!controller && !ownedController.current) {
    ownedController.current = createLaymanCanvasController();
  }

  const resolvedController = controller ?? ownedController.current;
  if (!resolvedController) {
    throw new Error("LaymanCanvas requires a controller.");
  }

  return (
    <LegacyCanvasContext.Provider value={legacyCanvasProps}>
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
    </LegacyCanvasContext.Provider>
  );
}
