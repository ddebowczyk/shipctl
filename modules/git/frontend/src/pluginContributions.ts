import {
  projectsService,
  type ConfigurationContribution,
  type ModuleActivationContext,
  type PanelContribution,
  type ProjectActionContribution,
  type ProjectFacts,
  type ProjectFactsProviderContribution,
  type ProjectImportContribution,
  type ProjectLayoutContribution,
  type ProjectNavigationContribution,
  type SemanticEventLease,
  type SettingsContribution,
} from "@shipctl/module-api";

import {
  configureGitPreferences,
  DEFAULT_GIT_PREFERENCES,
  loadGitPreferences,
  releaseGitPreferences,
  useGitPreferencesStore,
  validateGitPreferences,
  type GitPreferences,
} from "./gitPreferences.ts";
import { gitClientFor } from "./gitClient.ts";
import { useGitStore } from "./store.ts";
import type { GitStatus } from "./types.ts";

export const GIT_MODULE_ID = "shipctl.git" as const;
export const GIT_PLUGIN_VERSION = "0.0.0" as const;
export const GIT_PANEL_ID = "core.git" as const;

const factCache = new WeakMap<GitStatus, ProjectFacts>();

export function factsForStatus(status: GitStatus | undefined): ProjectFacts | null {
  if (!status?.isRepository) return null;
  const cached = factCache.get(status);
  if (cached) return cached;
  const facts: ProjectFacts = {
    ...(status.branchName
      ? { revision: { label: status.branchName, state: status.dirty ? "changed" : "clean" } }
      : {}),
    ...(status.worktreeParentProjectId
      ? { lineage: { parentLabel: status.worktreeParentProjectId } }
      : {}),
  };
  factCache.set(status, facts);
  return facts;
}

/**
 * Presentation declarations remain inert until the artifact registers them
 * through its activation context. There is intentionally no ShipctlModule
 * compatibility object for the Git runtime.
 */
export const gitContributions = Object.freeze({
  configuration: Object.freeze([
    {
      id: "git.preferences",
      moduleId: GIT_MODULE_ID,
      scope: "global",
      key: "preferences",
      schemaVersion: 1,
      defaults: DEFAULT_GIT_PREFERENCES,
      validate: validateGitPreferences,
    },
  ] satisfies readonly ConfigurationContribution<GitPreferences>[]),
  panels: Object.freeze([
    {
      id: GIT_PANEL_ID,
      moduleId: GIT_MODULE_ID,
      scope: "project",
      label: "Files",
      icon: { name: "folder-tree" },
      shortcut: "⌘G",
      singleton: "per-project",
      order: 10,
      unavailable: {
        title: "Files panel unavailable",
        description: "The Git and file browser module could not be loaded.",
      },
      migrationAlias: { kind: "git", label: "Files" },
      load: () => import("./GitPanel"),
    },
  ] satisfies readonly PanelContribution[]),
  projectNavigation: Object.freeze([
    {
      id: "git.project-navigation",
      moduleId: GIT_MODULE_ID,
      panelId: GIT_PANEL_ID,
      order: 10,
      load: () => import("./GitStatusRow"),
    },
  ] satisfies readonly ProjectNavigationContribution[]),
  projectLayout: Object.freeze([
    {
      id: "git.diff-summary",
      moduleId: GIT_MODULE_ID,
      slot: "workspace.trailing",
      order: 10,
      load: () => import("./DiffSummaryPanel"),
    },
  ] satisfies readonly ProjectLayoutContribution[]),
  projectActions: Object.freeze([
    {
      id: "git.project-actions",
      moduleId: GIT_MODULE_ID,
      order: 30,
      getGroup: () => ({
        label: null,
        actions: [
          {
            id: "git.create-worktree",
            label: "Create Worktree",
            icon: { name: "plus" },
            surface: { load: () => import("./CreateWorktreeProjectActionSurface") },
          },
        ],
      }),
    },
  ] satisfies readonly ProjectActionContribution[]),
  projectFacts: Object.freeze([
    {
      id: "git.project-facts",
      moduleId: GIT_MODULE_ID,
      getFacts: (project) => factsForStatus(
        useGitStore.getState().projectGitStatus[project.path],
      ),
      subscribe: (listener) => useGitStore.subscribe(listener),
    },
  ] satisfies readonly ProjectFactsProviderContribution[]),
  projectImports: Object.freeze([
    {
      id: "git.related-projects",
      moduleId: GIT_MODULE_ID,
      relatedPaths: async (projectPath, { expandRelated }, _services, activation) => {
        const worktrees = await gitClientFor(activation).listWorktrees(projectPath);
        const current = worktrees.find((worktree) => worktree.projectId === projectPath);
        if (!current) return [];
        if (!current.isMain) {
          return worktrees.filter((worktree) => worktree.isMain).map((worktree) => worktree.projectId);
        }
        const autoImportWorktrees = useGitPreferencesStore.getState().preferences
          ?.autoImportWorktrees ?? DEFAULT_GIT_PREFERENCES.autoImportWorktrees;
        return expandRelated && autoImportWorktrees
          ? worktrees.filter((worktree) => !worktree.isMain).map((worktree) => worktree.projectId)
          : [];
      },
    },
  ] satisfies readonly ProjectImportContribution[]),
  settings: Object.freeze([
    {
      id: "git.settings",
      moduleId: GIT_MODULE_ID,
      order: 10,
      load: () => import("./GitSettingsSection"),
    },
  ] satisfies readonly SettingsContribution[]),
});

/**
 * Own Git's derived repository state from the generic project catalog and the
 * semantic repository-change event source. The raw `git-fs-changed` transport
 * remains in the trusted platform adapter; this plugin only receives scoped,
 * activation-owned repository-change leases.
 */
export async function activateGitRuntime(
  activation: ModuleActivationContext,
): Promise<() => Promise<void>> {
  configureGitPreferences(activation);
  let active = true;
  let projectSubscription: SemanticEventLease | null = null;
  const repositorySubscriptions = new Map<string, SemanticEventLease>();
  const currentProjectIds = new Set<string>();
  const client = gitClientFor(activation);

  const releaseProject = async (projectId: string) => {
    currentProjectIds.delete(projectId);
    const subscription = repositorySubscriptions.get(projectId);
    repositorySubscriptions.delete(projectId);
    await subscription?.dispose();
    useGitStore.getState().removeProject(projectId);
  };

  const subscribeProject = async (projectId: string) => {
    if (repositorySubscriptions.has(projectId) || !currentProjectIds.has(projectId)) return;
    try {
      const subscription = await client.subscribeChanges(projectId, async () => {
        if (!active || !currentProjectIds.has(projectId)) return;
        await useGitStore.getState().refreshStatus(projectId, client);
      });
      if (!active || !currentProjectIds.has(projectId)) {
        await subscription.dispose();
        return;
      }
      repositorySubscriptions.set(projectId, subscription);
    } catch {
      // Repository observation is optional: status refresh remains best-effort.
    }
  };

  const synchronizeProjects = async (projectIds: readonly string[]) => {
    const nextProjectIds = new Set(projectIds);
    for (const projectId of [...currentProjectIds]) {
      if (!nextProjectIds.has(projectId)) await releaseProject(projectId);
    }
    for (const projectId of nextProjectIds) currentProjectIds.add(projectId);
    await Promise.all([...currentProjectIds].map((projectId) => subscribeProject(projectId)));
    if (active) await useGitStore.getState().refreshAll([...currentProjectIds], client);
  };

  const cleanup = async () => {
    if (!active) return;
    active = false;
    await projectSubscription?.dispose();
    for (const projectId of [...currentProjectIds]) await releaseProject(projectId);
    releaseGitPreferences(activation);
  };

  try {
    await loadGitPreferences();
    const projects = activation.services.require(projectsService);
    projectSubscription = await projects.observeProjects.subscribe("catalog", async ({ value }) => {
      switch (value.kind) {
        case "catalog-changed":
          await synchronizeProjects(value.projectIds);
          break;
        case "filesystem-changed":
          // Git receives the matching repository change through its own
          // semantic service, avoiding a second raw-event listener or refresh.
          break;
        case "project-removed":
          await releaseProject(value.projectId);
          break;
      }
    });
    const initial = await projects.listProjects.execute({});
    if (initial.result.ok) await synchronizeProjects(initial.result.value.projectIds);
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
