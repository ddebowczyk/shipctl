import { useEffect, useRef } from "react";
import {
  observeGitFilesystemChanges,
  watchRepo,
  unwatchRepo,
} from "@shipctl/core/platform";
import type {
  ModuleActivationContext,
  ModuleId,
  ShipctlModule,
} from "@shipctl/module-api";
import {
  MODULE_HOST_SERVICES,
  notifyModulesFilesystemChanged,
  notifyModulesProjectsChanged,
} from "@shipctl/core/host";

/**
 * Watches project paths and forwards file-system events to module lifecycles.
 * Each project (including worktrees added as separate projects) is watched independently.
 */
export function useProjectWatcher(
  projectPaths: string[],
  moduleActivations: ReadonlyMap<ModuleId, ModuleActivationContext>,
  modules: readonly ShipctlModule[],
) {
  const watchedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const unlisten = observeGitFilesystemChanges((paths) => {
      void notifyModulesFilesystemChanged(
        paths,
        MODULE_HOST_SERVICES,
        moduleActivations,
        modules,
      );
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, [moduleActivations, modules]);

  useEffect(() => {
    const current = new Set(projectPaths);
    const watched = watchedRef.current;

    // Watch newly added paths
    for (const path of current) {
      if (!watched.has(path)) {
        watched.add(path);
        void watchRepo(path).catch(() => {
          watchedRef.current.delete(path);
        });
      }
    }

    // Unwatch removed paths
    for (const path of [...watched]) {
      if (!current.has(path)) {
        watched.delete(path);
        void unwatchRepo(path).catch(() => undefined);
      }
    }

    // Initial refresh
    void notifyModulesProjectsChanged(
      projectPaths,
      MODULE_HOST_SERVICES,
      moduleActivations,
      modules,
    );
  }, [projectPaths.join("\0"), moduleActivations, modules]);

  useEffect(() => {
    return () => {
      for (const path of watchedRef.current) {
        void unwatchRepo(path).catch(() => undefined);
      }
      watchedRef.current.clear();
    };
  }, []);
}
