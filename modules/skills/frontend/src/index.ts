import type { ModuleSkillsSnapshot, ShepModule } from "@shep/module-api";

import { useSkillStore } from "./store";

let skillsSource: ReturnType<typeof useSkillStore.getState> | null = null;
let skillsSnapshot: ModuleSkillsSnapshot = { byProject: {} };

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
  id: "shep.skills",
  version: "0.0.0",
  skillsProvider: {
    id: "skills.provider",
    moduleId: "shep.skills",
    port: {
      getSnapshot: getSkillsSnapshot,
      subscribe: (listener) => useSkillStore.subscribe(listener),
      install: (projectPath, name) => useSkillStore.getState().install(projectPath, name),
    },
  },
  projectActions: [
    {
      id: "skills.project-actions",
      moduleId: "shep.skills",
      order: 20,
      subscribe: (listener) => useSkillStore.subscribe(listener),
      refresh: (project) => useSkillStore.getState().refresh(project.path),
      getGroup: (project, services) => {
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
                await (skill.installed
                  ? store.uninstall(project.path, skill.name)
                  : store.install(project.path, skill.name));
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
    onProjectsChanged: (projectPaths) => useSkillStore.getState().refreshAll([...projectPaths]),
    onFilesystemChanged: (projectPaths) => useSkillStore.getState().refreshAll([...projectPaths]),
    onProjectRemoved: (projectPath) => useSkillStore.getState().removeProject(projectPath),
  },
} as const satisfies ShepModule;

export { SKILL_COMMANDS } from "./client";
export type { SkillInfo } from "./types";
