import { useRef } from "react";
import type { LaymanController } from "react-layman";

import {
  createLaymanCanvasController,
  createLaymanWorkspaceState,
  LaymanCanvas,
} from "@shipctl/core/canvas/views";
import type {
  CanvasAdapterProps,
  LaymanCanvasPaneData,
} from "@shipctl/core/canvas/views";

/**
 * Supplies the selected Layman renderer with a controller. Durable workspace
 * state now enters through `props.workspace`, which is owned by the semantic
 * workspace authority. The previous raw Layman snapshot bridge remains as a
 * migration-only implementation and is intentionally not started here.
 */
export default function LaymanCanvasRuntimeAdapter(props: CanvasAdapterProps) {
  const controllerRef = useRef<LaymanController<LaymanCanvasPaneData> | null>(null);

  if (!controllerRef.current) {
    controllerRef.current = createLaymanCanvasController(
      props.workspace ? createLaymanWorkspaceState(props.workspace.projection) : undefined,
    );
  }

  return <LaymanCanvas {...props} controller={controllerRef.current} />;
}
