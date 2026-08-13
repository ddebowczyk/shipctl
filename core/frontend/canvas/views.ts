// React surface kept separate from ./index.ts for node:test consumers.
export { default as CanvasHost } from "./CanvasHost.tsx";
export type { CanvasHostProps } from "./CanvasHost.tsx";
export { resolveCanvasAdapter } from "./canvasAdapterResolver.tsx";
export type {
  CanvasAdapterProps,
  CanvasAdapterView,
} from "./adapterTypes.ts";
export type { CanvasAdapterRegistry } from "./canvasAdapterResolver.tsx";
export {
  createLaymanCanvasController,
  createLaymanCanvasState,
  default as LaymanCanvas,
  LAYMAN_CANVAS_TAB_ID,
  LAYMAN_CANVAS_WINDOW_ID,
  LAYMAN_CANVAS_WORKSPACE_ID,
  LAYMAN_SOURCE_REVISION,
} from "./layman/LaymanCanvas.tsx";
export type { LaymanCanvasProps } from "./layman/LaymanCanvas.tsx";
export type { LaymanCanvasPaneData } from "./layman/LaymanCanvas.tsx";
export {
  createLaymanWorkspaceBridge,
  serializeState,
} from "./layman/workspaceBridge.ts";
export type {
  LaymanSnapshotPort,
  LaymanSnapshotSaveRequest,
  LaymanSnapshotSaveResult,
  LaymanWorkspaceBridge,
  LaymanWorkspaceBridgeEvent,
  LaymanWorkspaceUpdate,
} from "./layman/workspaceBridge.ts";
export type {
  CanvasGlobalSurfaceRendererProps,
  CanvasPanelRendererProps,
  CanvasSidebarRendererProps,
  CanvasTabBarRendererProps,
  CanvasTerminalRendererProps,
  CanvasTrailingLayoutRendererProps,
  CanvasViewPorts,
} from "./viewPorts.ts";
