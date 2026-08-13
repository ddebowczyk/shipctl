import type { CanvasAdapterView } from "@shipctl/core/canvas/views";
import type { CanvasAdapterId } from "@shipctl/core/platform";

import LaymanCanvasRuntimeAdapter from "./LaymanCanvasRuntimeAdapter.tsx";

/**
 * Binds host services after bootstrap has selected a pure canvas adapter.
 * This does not change the selected adapter during an application lifetime.
 */
export function bindCanvasAdapterRuntime(
  adapterId: CanvasAdapterId,
  adapter: CanvasAdapterView,
): CanvasAdapterView {
  return adapterId === "layman" ? LaymanCanvasRuntimeAdapter : adapter;
}

export { default as LaymanCanvasRuntimeAdapter } from "./LaymanCanvasRuntimeAdapter.tsx";
