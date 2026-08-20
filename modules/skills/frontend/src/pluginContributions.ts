import {
  projectsService,
  type ModuleActivationContext,
  type ModuleSkillsSnapshot,
  type ProjectActionContribution,
  type SemanticEventLease,
  type SkillsProviderContribution,
} from "@shipctl/module-api";

import { skillInstallationClientFor } from "./skillInstallationClient.ts";
import { useSkillStore } from "./store.ts";

export const SKILLS_MODULE_ID = "shipctl.skills" as const;
export const SKILLS_PLUGIN_VERSION = "0.0.0" as const;

let skillsSource: ReturnType<typeof useSkillStore.getState> | null = null;
let skillsSnapshot: ModuleSkillsSnapshot = { byProject: {} };
let activeActivation: ModuleActivationContext | null = null;

function getSkillsSnapshot() {
  const source = useSkillStore.getState();
  if (source !== skillsSource) {
    skillsSource = source;
    skillsSnapshot = { byProject: source.skillsByRepo };
  }
  return skillsSnapshot;
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  if (
    typeof error === "object"
    && error !== null
    && "message" in error
    && typeof error.message === "string"
    && error.message.trim()
  ) {
    return error.message;
  }
  return "Something went wrong.";
}

/**
 * Inert contribution declarations. The direct artifact owns their registration
 * leases through its activation context, rather than exposing a static module
 * compatibility object.
 */
export const skillsContributions = Object.freeze({
  skillsProviders: Object.freeze([
    {
      id: "skills.provider",
      moduleId: SKILLS_MODULE_ID,
      port: {
        getSnapshot: getSkillsSnapshot,
        subscribe: (listener) => useSkillStore.subscribe(listener),
        install: (projectPath, name) => {
          if (!activeActivation || activeActivation.disposed) {
            return Promise.reject(new Error("Skills module is not active"));
          }
          return useSkillStore.getState().install(
            projectPath,
            name,
            skillInstallationClientFor(activeActivation),
          );
        },
      },
    },
  ] satisfies readonly SkillsProviderContribution[]),
  projectActions: Object.freeze([
    {
      id: "skills.project-actions",
      moduleId: SKILLS_MODULE_ID,
      order: 20,
      subscribe: (listener) => useSkillStore.subscribe(listener),
      refresh: (project, _services, activation) => useSkillStore.getState().refresh(
        project.path,
        skillInstallationClientFor(activation),
      ),
      getGroup: (project, services, activation) => {
        const skills = useSkillStore.getState().skillsByRepo[project.path] ?? [];
        if (skills.length === 0) return null;
        return {
          label: "Agent Skills",
          icon: { name: "sparkles" },
          actions: skills.map((skill) => ({
            id: `skills.${skill.name}`,
            label: skill.title,
            selected: skill.installed,
            keepOpen: true,
            run: async () => {
              try {
                const store = useSkillStore.getState();
                const client = skillInstallationClientFor(activation);
                await (skill.installed
                  ? store.uninstall(project.path, skill.name, client)
                  : store.install(project.path, skill.name, client));
              } catch (error) {
                services.notices.push({
                  tone: "error",
                  title: skill.installed
                    ? "Couldn't remove agent skill"
                    : "Couldn't add agent skill",
                  message: errorMessage(error),
                });
              }
            },
          })),
        };
      },
    },
  ] satisfies readonly ProjectActionContribution[]),
});

/**
 * Keep Skills' process-local cache synchronized by the generic project
 * catalog. The artifact owns the catalog lease, so deactivation removes both
 * the observer and the activation-scoped provider client.
 */
export async function activateSkillsRuntime(
  activation: ModuleActivationContext,
): Promise<() => Promise<void>> {
  let active = true;
  let projectSubscription: SemanticEventLease | null = null;
  const client = skillInstallationClientFor(activation);
  activeActivation = activation;

  const refreshProjects = async (projectIds: readonly string[]) => {
    if (!active) return;
    await useSkillStore.getState().refreshAll(projectIds, client);
  };

  const cleanup = async () => {
    if (!active) return;
    active = false;
    await projectSubscription?.dispose();
    if (activeActivation === activation) activeActivation = null;
  };

  try {
    const projects = activation.services.require(projectsService);
    projectSubscription = await projects.observeProjects.subscribe("catalog", async ({ value }) => {
      if (!active) return;
      switch (value.kind) {
        case "catalog-changed":
        case "filesystem-changed":
          await refreshProjects(value.projectIds);
          break;
        case "project-removed":
          useSkillStore.getState().removeProject(value.projectId);
          break;
      }
    });
    const initial = await projects.listProjects.execute({});
    if (initial.result.ok) await refreshProjects(initial.result.value.projectIds);
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
