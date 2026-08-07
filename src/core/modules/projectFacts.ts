import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import type {
  ModuleHostServices,
  ProjectFacts,
  ProjectFactsProviderContribution,
  ProjectRef,
} from "@shep/module-api";

import { enabledProjectFactsProvider } from "./moduleComposition";
import { MODULE_HOST_SERVICES } from "./moduleHostServices";

export function resolveProjectFacts(
  project: ProjectRef,
  services: ModuleHostServices,
  provider: ProjectFactsProviderContribution | null,
): ProjectFacts | null {
  if (!provider) return null;
  try {
    return provider.getFacts(project, services);
  } catch {
    return null;
  }
}

export function subscribeProjectFacts(
  listener: () => void,
  services: ModuleHostServices,
  provider: ProjectFactsProviderContribution | null,
): () => void {
  if (!provider?.subscribe) return () => undefined;
  try {
    return provider.subscribe(listener, services);
  } catch {
    return () => undefined;
  }
}

export async function refreshProjectFacts(
  project: ProjectRef,
  services: ModuleHostServices,
  provider: ProjectFactsProviderContribution | null,
): Promise<void> {
  try {
    await provider?.refresh?.(project, services);
  } catch {
    // Project metadata is optional; provider failures do not block the host.
  }
}

export function useProjectFacts(project: ProjectRef): ProjectFacts | null {
  const provider = useMemo(() => enabledProjectFactsProvider(), []);
  const subscribe = useCallback(
    (listener: () => void) => subscribeProjectFacts(
      listener,
      MODULE_HOST_SERVICES,
      provider,
    ),
    [provider],
  );
  const snapshot = useCallback(
    () => resolveProjectFacts(project, MODULE_HOST_SERVICES, provider),
    [project, provider],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export type ProjectFactsByPath = Readonly<Record<string, ProjectFacts | null>>;

/** Subscribe once while resolving generic facts for project-list host chrome. */
export function useProjectFactsMap(
  projects: readonly { readonly path: string; readonly name: string }[],
): ProjectFactsByPath {
  const provider = useMemo(() => enabledProjectFactsProvider(), []);
  const projectRefs = useMemo<readonly ProjectRef[]>(
    () => projects.map((project) => ({
      id: project.path,
      name: project.name,
      path: project.path,
    })),
    [projects],
  );
  const cache = useRef<ProjectFactsByPath>({});
  const subscribe = useCallback(
    (listener: () => void) => subscribeProjectFacts(
      listener,
      MODULE_HOST_SERVICES,
      provider,
    ),
    [provider],
  );
  const snapshot = useCallback(() => {
    const previous = cache.current;
    const next: Record<string, ProjectFacts | null> = {};
    let unchanged = Object.keys(previous).length === projectRefs.length;
    for (const project of projectRefs) {
      const facts = resolveProjectFacts(project, MODULE_HOST_SERVICES, provider);
      next[project.path] = facts;
      if (previous[project.path] !== facts) unchanged = false;
    }
    if (unchanged) return previous;
    cache.current = next;
    return next;
  }, [projectRefs, provider]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
