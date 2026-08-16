import {
  skillId,
  skillInstallationService,
  type ModuleActivationContext,
  type SemanticRequestOperation,
  type SkillInstallationErrorCode,
  type SkillInstallationService,
} from "@shipctl/module-api";

import type { SkillInfo } from "./types";

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
      const skills = await execute(service.inspectSkills, { projectId });
      return skills.map((skill): SkillInfo => ({
        name: skill.skillId,
        title: skill.title,
        description: skill.description,
        installed: skill.installed,
      }));
    },
    installSkill: async (projectId, id) => {
      await execute(service.installSkill, { projectId, skillId: skillId(id) });
    },
    removeSkill: async (projectId, id) => {
      await execute(service.removeSkill, { projectId, skillId: skillId(id) });
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
