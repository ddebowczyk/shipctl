import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { watchRepo, unwatchRepo } from "@shep/core/platform";
import {
  MODULE_HOST_SERVICES,
  notifyModulesFilesystemChanged,
  notifyModulesProjectsChanged,
} from "@shep/core/host";

interface FsChangedPayload {
  paths: string[];
}

/**
 * Watches project paths and forwards file-system events to module lifecycles.
 * Each project (including worktrees added as separate projects) is watched independently.
 */
export function useProjectWatcher(projectPaths: string[]) {
  const watchedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const unlisten = listen<FsChangedPayload>("git-fs-changed", (event) => {
      void notifyModulesFilesystemChanged(event.payload.paths, MODULE_HOST_SERVICES);
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);

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
    void notifyModulesProjectsChanged(projectPaths, MODULE_HOST_SERVICES);
  }, [projectPaths.join("\0")]);

  useEffect(() => {
    return () => {
      for (const path of watchedRef.current) {
        void unwatchRepo(path).catch(() => undefined);
      }
      watchedRef.current.clear();
    };
  }, []);
}
