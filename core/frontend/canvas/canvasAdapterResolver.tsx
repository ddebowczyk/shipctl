import type { CanvasAdapterId } from "@shipctl/core/configuration";

import StandardWorkspaceCanvas from "./standard/StandardWorkspaceCanvas.tsx";
import LaymanCanvas from "./layman/LaymanCanvas.tsx";
import type { CanvasAdapterView } from "./adapterTypes.ts";

/** A build can omit an adapter while preserving the stable configuration enum. */
export type CanvasAdapterRegistry = Readonly<Partial<Record<CanvasAdapterId, CanvasAdapterView>>>;

const BUNDLED_CANVAS_ADAPTERS = {
  standard: StandardWorkspaceCanvas,
  layman: LaymanCanvas,
} satisfies Record<CanvasAdapterId, CanvasAdapterView>;

/**
 * Resolves the one adapter that will exist for the current application
 * lifetime. Callers supply the typed bootstrap value; this function never
 * reads browser storage, Vite flags, or live application state.
 */
export function resolveCanvasAdapter(
  adapterId: CanvasAdapterId,
  registry: CanvasAdapterRegistry = BUNDLED_CANVAS_ADAPTERS,
): CanvasAdapterView {
  const adapter = registry[adapterId];
  if (!adapter) {
    throw new Error(`Canvas adapter \"${adapterId}\" is not available in this Shipctl build.`);
  }
  return adapter;
}
