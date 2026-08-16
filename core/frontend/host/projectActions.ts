import { useCallback, useEffect, useMemo, useReducer } from "react";
import type {
  ModuleActivationContext,
  ModuleId,
  ModuleHostServices,
  ProjectActionContribution,
  ProjectActionGroup,
  ProjectRef,
} from "@shipctl/module-api";

import { enabledProjectActionContributions } from "./moduleComposition.ts";
import { MODULE_HOST_SERVICES } from "./moduleHostServices.ts";

export interface HostedProjectActionGroup extends ProjectActionGroup {
  readonly moduleId: ModuleId;
}

export function resolveProjectActionGroups(
  project: ProjectRef,
  services: ModuleHostServices,
  contributions: readonly ProjectActionContribution[],
  activations: ReadonlyMap<ModuleId, ModuleActivationContext>,
): readonly HostedProjectActionGroup[] {
  return contributions.flatMap((contribution) => {
    try {
      const activation = activations.get(contribution.moduleId);
      if (!activation || activation.disposed) return [];
      const group = contribution.getGroup(project, services, activation);
      return group ? [{ ...group, moduleId: contribution.moduleId }] : [];
    } catch {
      return [];
    }
  });
}

export async function refreshProjectActions(
  project: ProjectRef,
  services: ModuleHostServices,
  contributions: readonly ProjectActionContribution[],
  activations: ReadonlyMap<ModuleId, ModuleActivationContext>,
): Promise<void> {
  await Promise.allSettled(contributions.map((contribution) => {
    const activation = activations.get(contribution.moduleId);
    return activation && !activation.disposed
      ? contribution.refresh?.(project, services, activation)
      : undefined;
  }));
}

export function subscribeProjectActions(
  listener: () => void,
  services: ModuleHostServices,
  contributions: readonly ProjectActionContribution[],
  activations: ReadonlyMap<ModuleId, ModuleActivationContext>,
): () => void {
  const cleanups = contributions.flatMap((contribution) => {
    try {
      const activation = activations.get(contribution.moduleId);
      if (!activation || activation.disposed) return [];
      const cleanup = contribution.subscribe?.(listener, services, activation);
      return cleanup ? [cleanup] : [];
    } catch {
      return [];
    }
  });
  return () => {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // One module cleanup must not block the remaining subscriptions.
      }
    }
  };
}

export function useModuleProjectActions(
  project: ProjectRef,
  activations: ReadonlyMap<ModuleId, ModuleActivationContext>,
): {
  readonly groups: readonly HostedProjectActionGroup[];
  readonly refresh: () => Promise<void>;
} {
  const contributions = useMemo(() => enabledProjectActionContributions(), []);
  const [, render] = useReducer((revision: number) => revision + 1, 0);

  useEffect(
    () => subscribeProjectActions(
      render,
      MODULE_HOST_SERVICES,
      contributions,
      activations,
    ),
    [activations, contributions],
  );

  const refresh = useCallback(
    () => refreshProjectActions(
      project,
      MODULE_HOST_SERVICES,
      contributions,
      activations,
    ),
    [activations, contributions, project],
  );

  return {
    groups: resolveProjectActionGroups(
      project,
      MODULE_HOST_SERVICES,
      contributions,
      activations,
    ),
    refresh,
  };
}
