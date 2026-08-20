import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import type {
  ModuleActivationContext,
  ModuleHostServices,
  ModuleId,
} from "@shipctl/module-api";

import type { TerminalPresentationRegistry } from "./terminalPresentationRegistry.ts";

/**
 * Trusted frame inputs for terminal presentation. Terminal views read this
 * narrow runtime directly instead of receiving activation or service maps
 * through a workspace renderer.
 */
export interface TerminalPresentationRuntime {
  readonly registry: TerminalPresentationRegistry;
  readonly moduleActivations: ReadonlyMap<ModuleId, ModuleActivationContext>;
  readonly services: Pick<
    ModuleHostServices,
    "notices" | "externalLinks" | "terminalPresentation"
  >;
  readonly activeProjectPath: string | null;
  readonly activeTabId: string | null;
}

const TerminalPresentationRuntimeContext = createContext<
  TerminalPresentationRuntime | undefined
>(undefined);

export function TerminalPresentationRuntimeProvider({
  registry,
  moduleActivations,
  services,
  activeProjectPath,
  activeTabId,
  children,
}: TerminalPresentationRuntime & { readonly children: ReactNode }) {
  const runtime = useMemo<TerminalPresentationRuntime>(() => Object.freeze({
    registry,
    moduleActivations,
    services,
    activeProjectPath,
    activeTabId,
  }), [activeProjectPath, activeTabId, moduleActivations, registry, services]);

  return (
    <TerminalPresentationRuntimeContext.Provider value={runtime}>
      {children}
    </TerminalPresentationRuntimeContext.Provider>
  );
}

export function useTerminalPresentationRuntime(): TerminalPresentationRuntime {
  const runtime = useContext(TerminalPresentationRuntimeContext);
  if (runtime === undefined) {
    throw new Error("Terminal presentation runtime is unavailable.");
  }
  return runtime;
}
