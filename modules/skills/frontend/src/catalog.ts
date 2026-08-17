import { skillId, type SkillDescriptor } from "@shipctl/module-api";

import orchestrateMarkdown from "../resources/orchestrate_skill.md?raw";
import todosMarkdown from "../resources/todo_skill.md?raw";

export interface SkillSource extends SkillDescriptor {
  readonly markdown: string;
}

/** Built-in feature catalog owned by the TypeScript Skills plugin. */
export const BUILTIN_SKILL_SOURCES: readonly SkillSource[] = Object.freeze([
  Object.freeze({
    skillId: skillId("shipctl-todos"),
    title: "Project to-dos",
    description: "Teaches agents to keep TODO.md as a kanban board: move cards when starting or finishing work, add discovered work to the backlog, and reconcile the board before ending a session.",
    markdown: todosMarkdown,
  }),
  Object.freeze({
    skillId: skillId("orchestrate"),
    title: "Orchestrate",
    description: "Turns any agent into a planner/orchestrator that delegates implementation to a different agent CLI running headless (codex, claude, opencode), reviews each task, and finishes with a fresh-context audit.",
    markdown: orchestrateMarkdown,
  }),
]);
