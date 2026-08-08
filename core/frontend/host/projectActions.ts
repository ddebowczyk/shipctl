import { useCallback, useEffect, useMemo, useReducer } from "react";
import type {
  ModuleHostServices,
  ProjectActionContribution,
  ProjectActionGroup,
  ProjectRef,
} from "@shipctl/module-api";

import { enabledProjectActionContributions } from "./moduleComposition.ts";
import { MODULE_HOST_SERVICES } from "./moduleHostServices.ts";

export function resolveProjectActionGroups(
  project: ProjectRef,
  services: ModuleHostServices,
  contributions: readonly ProjectActionContribution[],
): readonly ProjectActionGroup[] {
  return contributions.flatMap((contribution) => {
    try {
      const group = contribution.getGroup(project, services);
      return group ? [group] : [];
    } catch {
      return [];
    }
  });
}

export async function refreshProjectActions(
  project: ProjectRef,
  services: ModuleHostServices,
  contributions: readonly ProjectActionContribution[],
): Promise<void> {
  await Promise.allSettled(contributions.map((contribution) => (
    contribution.refresh?.(project, services)
  )));
}

export function subscribeProjectActions(
  listener: () => void,
  services: ModuleHostServices,
  contributions: readonly ProjectActionContribution[],
): () => void {
  const cleanups = contributions.flatMap((contribution) => {
    try {
      const cleanup = contribution.subscribe?.(listener, services);
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

export function useModuleProjectActions(project: ProjectRef): {
  readonly groups: readonly ProjectActionGroup[];
  readonly refresh: () => Promise<void>;
} {
  const contributions = useMemo(() => enabledProjectActionContributions(), []);
  const [, render] = useReducer((revision: number) => revision + 1, 0);

  useEffect(
    () => subscribeProjectActions(render, MODULE_HOST_SERVICES, contributions),
    [contributions],
  );

  const refresh = useCallback(
    () => refreshProjectActions(project, MODULE_HOST_SERVICES, contributions),
    [contributions, project],
  );

  return {
    groups: resolveProjectActionGroups(project, MODULE_HOST_SERVICES, contributions),
    refresh,
  };
}
