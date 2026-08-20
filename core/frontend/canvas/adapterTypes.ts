import type { ComponentType } from "react";

import type { WorkspaceCanvas } from "@shipctl/core/workspace";

/** The complete input contract for a main-canvas implementation. */
export interface CanvasAdapterProps {
  /** Optional while the host restores the durable semantic workspace. */
  readonly workspace?: WorkspaceCanvas;
}

/** A canvas implementation selected once before the shell mounts. */
export type CanvasAdapterView = ComponentType<CanvasAdapterProps>;
