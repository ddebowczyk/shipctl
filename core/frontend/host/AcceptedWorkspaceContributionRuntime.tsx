import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import type { ModuleActivationContext, ModuleId } from "@shipctl/module-api";

import type { WorkspaceContributionCatalog } from "./workspaceContributionCatalog.ts";

/**
 * Host-only access to the UI contributions from the runtime family that was
 * accepted by the live supervisor. Module code never imports this context.
 */
export interface AcceptedWorkspaceContributionRuntime {
  readonly catalog: WorkspaceContributionCatalog;
  readonly moduleActivations: ReadonlyMap<ModuleId, ModuleActivationContext>;
}

const AcceptedWorkspaceContributionRuntimeContext = createContext<
  AcceptedWorkspaceContributionRuntime | undefined
>(undefined);

export function AcceptedWorkspaceContributionRuntimeProvider({
  catalog,
  moduleActivations,
  children,
}: AcceptedWorkspaceContributionRuntime & { readonly children: ReactNode }) {
  const runtime = useMemo<AcceptedWorkspaceContributionRuntime>(() => Object.freeze({
    catalog,
    moduleActivations,
  }), [catalog, moduleActivations]);
  return (
    <AcceptedWorkspaceContributionRuntimeContext.Provider value={runtime}>
      {children}
    </AcceptedWorkspaceContributionRuntimeContext.Provider>
  );
}

export function useAcceptedWorkspaceContributionRuntime(): AcceptedWorkspaceContributionRuntime {
  const runtime = useContext(AcceptedWorkspaceContributionRuntimeContext);
  if (runtime === undefined) {
    throw new Error("Accepted workspace contributions are unavailable.");
  }
  return runtime;
}
