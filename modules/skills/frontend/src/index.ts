import type {
  ModuleActivationContext,
  ModuleSkillsSnapshot,
  ShipctlModule,
} from "@shipctl/module-api";

import { skillInstallationClientFor } from "./skillInstallationClient";
import { useSkillStore } from "./store";

let skillsSource: ReturnType<typeof useSkillStore.getState> | null = null;
let skillsSnapshot: ModuleSkillsSnapshot = { byProject: {} };
let activeActivation: ModuleActivationContext | null = null;

function getSkillsSnapshot(): ModuleSkillsSnapshot {
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

export const skillsModule = {
  id: "shipctl.skills",
  version: "0.0.0",
  skillsProvider: {
    id: "skills.provider",
    moduleId: "shipctl.skills",
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
  projectActions: [
    {
      id: "skills.project-actions",
      moduleId: "shipctl.skills",
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
  ],
  projectLifecycle: {
    onProjectsChanged: (projectPaths, _services, activation) => (
      useSkillStore.getState().refreshAll(
        projectPaths,
        skillInstallationClientFor(activation),
      )
    ),
    onFilesystemChanged: (projectPaths, _services, activation) => (
      useSkillStore.getState().refreshAll(
        projectPaths,
        skillInstallationClientFor(activation),
      )
    ),
    onProjectRemoved: (projectPath) => useSkillStore.getState().removeProject(projectPath),
  },
  activate: ({ activation }) => {
    activeActivation = activation;
    return {
      deactivate: () => {
        if (activeActivation === activation) activeActivation = null;
      },
    };
  },
} as const satisfies ShipctlModule;

export type { SkillInfo } from "./types";
