import {
  skillId,
  skillInstallationService,
  type ModuleActivationContext,
  type SemanticRequestOperation,
  type SkillInstallationErrorCode,
  type SkillInstallationService,
} from "@shipctl/module-api";

import type { SkillInfo } from "./types";
import { BUILTIN_SKILL_SOURCES } from "./catalog";

export class SkillInstallationClientError extends Error {
  readonly code: SkillInstallationErrorCode;

  constructor(code: SkillInstallationErrorCode, message: string) {
    super(message);
    this.name = "SkillInstallationClientError";
    this.code = code;
  }
}

async function execute<Input, Output>(
  operation: SemanticRequestOperation<Input, Output, SkillInstallationErrorCode>,
  input: Input,
): Promise<Output> {
  const outcome = await operation.execute(input);
  if (!outcome.result.ok) {
    throw new SkillInstallationClientError(
      outcome.result.error.code,
      outcome.result.error.message,
    );
  }
  return outcome.result.value;
}

export interface SkillInstallationClient {
  listSkills(projectId: string): Promise<readonly SkillInfo[]>;
  installSkill(projectId: string, id: string): Promise<void>;
  removeSkill(projectId: string, id: string): Promise<void>;
}

export function createSkillInstallationClient(
  service: SkillInstallationService,
): SkillInstallationClient {
  const client: SkillInstallationClient = {
    listSkills: async (projectId) => {
      const skills = await execute(service.inspectSkills, {
        projectId,
        catalog: BUILTIN_SKILL_SOURCES.map(({ skillId: id, title, description }) => ({
          skillId: id,
          title,
          description,
        })),
      });
      return skills.map((skill): SkillInfo => ({
        name: skill.skillId,
        title: skill.title,
        description: skill.description,
        installed: skill.installed,
      }));
    },
    installSkill: async (projectId, id) => {
      const selectedId = skillId(id);
      const skill = BUILTIN_SKILL_SOURCES.find((source) => source.skillId === selectedId);
      if (!skill) {
        throw new SkillInstallationClientError(
          "skill-installation.unknown-skill",
          `Unknown skill: ${id}`,
        );
      }
      await execute(service.installSkill, { projectId, skill });
    },
    removeSkill: async (projectId, id) => {
      const selectedId = skillId(id);
      if (!BUILTIN_SKILL_SOURCES.some((source) => source.skillId === selectedId)) {
        throw new SkillInstallationClientError(
          "skill-installation.unknown-skill",
          `Unknown skill: ${id}`,
        );
      }
      await execute(service.removeSkill, { projectId, skillId: selectedId });
    },
  };
  return Object.freeze(client);
}

export function skillInstallationClientFor(
  activation: ModuleActivationContext,
): SkillInstallationClient {
  return createSkillInstallationClient(
    activation.services.require(skillInstallationService),
  );
}
