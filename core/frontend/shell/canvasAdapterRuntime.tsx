import { createContext, useContext, type ReactNode } from "react";

import type { CanvasAdapterId } from "@shipctl/core/platform";

const CanvasAdapterRuntimeContext = createContext<CanvasAdapterId | null>(null);

interface CanvasAdapterRuntimeProviderProps {
  readonly adapterId: CanvasAdapterId;
  readonly children: ReactNode;
}

/** Shares the bootstrap-fixed canvas fact with shell-owned surfaces. */
export function CanvasAdapterRuntimeProvider({
  adapterId,
  children,
}: CanvasAdapterRuntimeProviderProps) {
  return (
    <CanvasAdapterRuntimeContext.Provider value={adapterId}>
      {children}
    </CanvasAdapterRuntimeContext.Provider>
  );
}

/** The value is unavailable until bootstrap has selected one adapter. */
export function useCanvasAdapterRuntime(): CanvasAdapterId {
  const adapterId = useContext(CanvasAdapterRuntimeContext);
  if (!adapterId) {
    throw new Error("Canvas adapter runtime is unavailable before Shipctl bootstrap.");
  }
  return adapterId;
}
