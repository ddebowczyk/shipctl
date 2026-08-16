import { defineSemanticService } from "./semanticServices.ts";
import type { SemanticRequestOperation } from "./semanticServices";

declare const skillIdBrand: unique symbol;

/** Stable identity from an approved host skill catalog. */
export type SkillId = string & { readonly [skillIdBrand]: true };

export function skillId(value: string): SkillId {
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized)) {
    throw new Error(`Invalid skill identity: ${value}`);
  }
  return normalized as SkillId;
}

export interface InspectSkillsInput {
  readonly projectId: string;
}

export interface SkillInspection {
  readonly skillId: SkillId;
  readonly title: string;
  readonly description: string;
  readonly installed: boolean;
}

export interface SkillMutationInput extends InspectSkillsInput {
  readonly skillId: SkillId;
}

export interface SkillMutationReceipt {
  readonly projectId: string;
  readonly skillId: SkillId;
  readonly installed: boolean;
}

export type SkillInstallationErrorCode =
  | "skill-installation.transport-failed"
  | "skill-installation.denied"
  | "skill-installation.invalid-project"
  | "skill-installation.unknown-skill"
  | "skill-installation.invalid-request"
  | "skill-installation.cancelled"
  | "skill-installation.activation-disposed";

export interface SkillInstallationService {
  readonly inspectSkills: SemanticRequestOperation<
    InspectSkillsInput,
    readonly SkillInspection[],
    SkillInstallationErrorCode
  >;
  readonly installSkill: SemanticRequestOperation<
    SkillMutationInput,
    SkillMutationReceipt,
    SkillInstallationErrorCode
  >;
  readonly removeSkill: SemanticRequestOperation<
    SkillMutationInput,
    SkillMutationReceipt,
    SkillInstallationErrorCode
  >;
}

export const skillInstallationService = defineSemanticService<SkillInstallationService>(
  "shipctl.skill-installation",
  1,
);
