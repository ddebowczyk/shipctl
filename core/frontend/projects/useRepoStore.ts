import { create } from "zustand";
import type {
  ModuleActivationContext,
  ModuleHostServices,
  ModuleId,
} from "@shipctl/module-api";
import type { RepoInfo, RepoGroup, WorkspaceConfig } from "@shipctl/core/platform";
import {
  listRepos,
  registerRepo,
  unregisterRepo,
  loadWorkspace,
  listGroups,
  createGroup as ipcCreateGroup,
  renameGroup as ipcRenameGroup,
  deleteGroup as ipcDeleteGroup,
  moveRepoToGroup as ipcMoveRepoToGroup,
} from "@shipctl/core/platform";
import { discoverRelatedProjectPaths } from "@shipctl/core/host";

const EMPTY_REPOS: RepoInfo[] = [];
const EMPTY_GROUPS: RepoGroup[] = [];

type RelatedImportMode = "expand-main" | "main-only";

interface QueueEntry {
  path: string;
  mode: RelatedImportMode;
  isPrimary: boolean;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function isMissingDirectoryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Directory does not exist:");
}

interface RepoStore {
  repos: RepoInfo[];
  groups: RepoGroup[];
  activeRepoPath: string | null;
  activeConfig: WorkspaceConfig | null;
  fetchRepos: () => Promise<void>;
  fetchGroups: () => Promise<void>;
  openRepo: (repoPath: string) => Promise<WorkspaceConfig>;
  addRepo: (
    repoPath: string,
    moduleServices: ModuleHostServices,
    moduleActivations: ReadonlyMap<ModuleId, ModuleActivationContext>,
  ) => Promise<WorkspaceConfig>;
  removeRepo: (repoPath: string) => Promise<void>;
  setActiveConfig: (config: WorkspaceConfig | null) => void;
  clearRepo: () => void;
  createGroup: (name: string) => Promise<RepoGroup>;
  renameGroup: (groupId: string, newName: string) => Promise<void>;
  deleteGroup: (groupId: string) => Promise<void>;
  moveRepoToGroup: (repoPath: string, groupId: string | null) => Promise<void>;
}

export const useRepoStore = create<RepoStore>((set, get) => ({
  repos: EMPTY_REPOS,
  groups: EMPTY_GROUPS,
  activeRepoPath: null,
  activeConfig: null,

  fetchRepos: async () => {
    const repos = await listRepos();
    set((state) => {
      const activeStillExists = state.activeRepoPath
        ? repos.some((repo) => repo.path === state.activeRepoPath)
        : true;

      return {
        repos,
        ...(activeStillExists ? {} : { activeRepoPath: null, activeConfig: null }),
      };
    });
  },

  fetchGroups: async () => {
    const groups = await listGroups();
    set({ groups });
  },

  openRepo: async (repoPath: string) => {
    const config = await loadWorkspace(repoPath);
    set({ activeRepoPath: repoPath, activeConfig: config });
    return config;
  },

  addRepo: async (
    repoPath: string,
    moduleServices: ModuleHostServices,
    moduleActivations: ReadonlyMap<ModuleId, ModuleActivationContext>,
  ) => {
    const knownPaths = new Set(get().repos.map((repo) => repo.path));
    const queuedPaths = new Set<string>();
    const queue: QueueEntry[] = [{ path: repoPath, mode: "expand-main", isPrimary: true }];
    let primaryRegistered: Awaited<ReturnType<typeof registerRepo>> | null = null;

    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;

      let registered: Awaited<ReturnType<typeof registerRepo>>;
      try {
        registered = await registerRepo(next.path);
      } catch (error) {
        // Auto-import should not block the user when Git still reports a stale,
        // already-deleted worktree path. Only the explicitly added path is fatal.
        if (!next.isPrimary && isMissingDirectoryError(error)) {
          continue;
        }
        throw error;
      }
      const canonicalPath = registered.path;
      knownPaths.add(canonicalPath);
      queuedPaths.add(canonicalPath);

      if (!primaryRegistered) {
        primaryRegistered = registered;
      }

      const relatedPaths = await discoverRelatedProjectPaths(
        canonicalPath,
        {
          expandRelated: next.mode === "expand-main",
        },
        moduleServices,
        moduleActivations,
      );

      for (const relatedPath of uniquePaths([...relatedPaths])) {
        if (knownPaths.has(relatedPath) || queuedPaths.has(relatedPath)) {
          continue;
        }
        queue.push({
          path: relatedPath,
          mode: "main-only",
          isPrimary: false,
        });
        queuedPaths.add(relatedPath);
      }
    }

    if (!primaryRegistered) {
      throw new Error("Failed to register project");
    }

    const repos = await listRepos();
    set({
      repos,
      activeRepoPath: primaryRegistered.path,
      activeConfig: primaryRegistered.workspace,
    });
    return primaryRegistered.workspace;
  },

  removeRepo: async (repoPath: string) => {
    await unregisterRepo(repoPath);
    const repos = await listRepos();
    const isActive = get().activeRepoPath === repoPath;
    set({
      repos,
      ...(isActive ? { activeRepoPath: null, activeConfig: null } : {}),
    });
  },

  setActiveConfig: (config: WorkspaceConfig | null) => {
    set({ activeConfig: config });
  },

  clearRepo: () => {
    set({ activeRepoPath: null, activeConfig: null });
  },

  createGroup: async (name: string) => {
    const group = await ipcCreateGroup(name);
    const groups = await listGroups();
    set({ groups });
    return group;
  },

  renameGroup: async (groupId: string, newName: string) => {
    await ipcRenameGroup(groupId, newName);
    const groups = await listGroups();
    set({ groups });
  },

  deleteGroup: async (groupId: string) => {
    await ipcDeleteGroup(groupId);
    const [groups, repos] = await Promise.all([listGroups(), listRepos()]);
    set({ groups, repos });
  },

  moveRepoToGroup: async (repoPath: string, groupId: string | null) => {
    await ipcMoveRepoToGroup(repoPath, groupId);
    const repos = await listRepos();
    set({ repos });
  },
}));
