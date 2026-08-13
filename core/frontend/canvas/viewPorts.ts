import type { ComponentType } from "react";

import type {
  CanvasActions,
  CanvasContentTarget,
  CanvasModel,
  CanvasPorts,
  CanvasTerminalSlot,
} from "./types.ts";

export interface CanvasSidebarRendererProps {
  readonly sidebar: CanvasModel["sidebar"];
  readonly actions: CanvasActions;
  readonly ports: CanvasPorts;
}

export interface CanvasTabBarRendererProps {
  readonly tabBar: CanvasModel["tabBar"];
  readonly activeProjectPath: string | null;
  readonly actions: CanvasActions;
}

export interface CanvasGlobalSurfaceRendererProps {
  readonly surfaceId: Extract<CanvasContentTarget, { readonly kind: "global-surface" }>["surfaceId"];
  readonly close: () => void;
  readonly ports: CanvasPorts;
}

export interface CanvasPanelRendererProps {
  readonly content: Extract<CanvasContentTarget, { readonly kind: "panel" }>;
  readonly close: () => void;
  readonly setTitle: (title: string | null) => void;
  readonly ports: CanvasPorts;
}

export interface CanvasTerminalRendererProps {
  readonly slot: CanvasTerminalSlot;
  readonly ports: CanvasPorts;
}

export interface CanvasTrailingLayoutRendererProps {
  readonly project: NonNullable<CanvasModel["trailingLayout"]["project"]>;
  readonly ports: CanvasPorts;
}

/** React surfaces that an adapter may swap in tests without changing the model. */
export interface CanvasViewPorts {
  readonly Sidebar: ComponentType<CanvasSidebarRendererProps>;
  readonly TabBar: ComponentType<CanvasTabBarRendererProps>;
  readonly GlobalSurface: ComponentType<CanvasGlobalSurfaceRendererProps>;
  readonly Panel: ComponentType<CanvasPanelRendererProps>;
  readonly Terminal: ComponentType<CanvasTerminalRendererProps>;
  readonly TrailingLayout: ComponentType<CanvasTrailingLayoutRendererProps>;
}
