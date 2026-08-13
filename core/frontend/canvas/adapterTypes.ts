import type { ComponentType } from "react";

import type {
  CanvasActions,
  CanvasModel,
  CanvasPorts,
} from "./types.ts";
import type { CanvasViewPorts } from "./viewPorts.ts";

/** The complete input contract for a main-canvas implementation. */
export interface CanvasAdapterProps {
  readonly model: CanvasModel;
  readonly actions: CanvasActions;
  readonly ports: CanvasPorts;
  /** Test-only override for inspecting adapter render requests. */
  readonly viewPorts?: Partial<CanvasViewPorts>;
}

/** A canvas implementation selected once before the shell mounts. */
export type CanvasAdapterView = ComponentType<CanvasAdapterProps>;
