import {
  skillInstallationService,
  type SkillId,
  type SkillInspection,
  type SkillInstallationErrorCode,
  type SkillInstallationService,
} from "../protocol/skillInstallation";
import type { SemanticServiceError } from "../protocol/semanticServices";
import type {
  SemanticServiceProvider,
  SemanticServiceProviderContext,
} from "../host/semanticServices";

import {
  createFakeRequestOperation,
  type FakeRequestTrace,
} from "./semanticServices";

export type FakeSkillInstallationOperation =
  | "inspect-skills"
  | "install-skill"
  | "remove-skill";

export interface FakeSkillCatalogSeed {
  readonly projectId: string;
  readonly skills: readonly SkillInspection[];
}

export interface FakeSkillInstallationTrace {
  readonly operation: FakeSkillInstallationOperation;
  readonly request: FakeRequestTrace<unknown>;
}

export interface FakeSkillInstallationProviderOptions {
  readonly projects?: readonly FakeSkillCatalogSeed[];
  readonly deniedOperations?: readonly FakeSkillInstallationOperation[];
  readonly trace?: FakeSkillInstallationTrace[];
}

class FakeSkillInstallationFailure extends Error {
  readonly code: SkillInstallationErrorCode;

  constructor(code: SkillInstallationErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

const CANCELLED = {
  code: "skill-installation.cancelled",
  message: "Skill request was cancelled",
  retryable: false,
} as const;

const DISPOSED = {
  code: "skill-installation.activation-disposed",
  message: "The module activation is no longer active",
  retryable: false,
} as const;

function failedError(
  error: unknown,
): SemanticServiceError<SkillInstallationErrorCode> {
  if (error instanceof FakeSkillInstallationFailure) {
    return { code: error.code, message: error.message, retryable: false };
  }
  return {
    code: "skill-installation.transport-failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

function operation<Input, Output>(
  context: SemanticServiceProviderContext,
  name: FakeSkillInstallationOperation,
  options: FakeSkillInstallationProviderOptions,
  handle: (input: Input) => Output | Promise<Output>,
) {
  const traces: FakeRequestTrace<Input>[] = [];
  const request = createFakeRequestOperation({
    context,
    policy: POLICY,
    handle: ({ input }) => {
      if (options.deniedOperations?.includes(name)) {
        throw new FakeSkillInstallationFailure(
          "skill-installation.denied",
          `Fake skill operation denied: ${name}`,
        );
      }
      return handle(input);
    },
    failedError,
    cancelledError: CANCELLED,
    disposedError: DISPOSED,
    trace: traces,
  });
  const execute = request.execute.bind(request);
  return Object.freeze({
    policy: request.policy,
    async execute(input: Input, requestOptions?: Parameters<typeof execute>[1]) {
      const traceCount = traces.length;
      const outcome = await execute(input, requestOptions);
      const captured = traces[traceCount];
      if (captured) options.trace?.push({ operation: name, request: captured });
      return outcome;
    },
  });
}

function cloneInspection(skill: SkillInspection): SkillInspection {
  return { ...skill };
}

/** Test-only skill provider with no DOM, Tauri, or filesystem dependency. */
export function createFakeSkillInstallationServiceProvider(
  options: FakeSkillInstallationProviderOptions = {},
): SemanticServiceProvider<SkillInstallationService> {
  return {
    service: skillInstallationService,
    bind(context) {
      const projects = new Map<string, Map<SkillId, SkillInspection>>();
      for (const project of options.projects ?? []) {
        projects.set(project.projectId, new Map(
          project.skills.map((skill) => [skill.skillId, cloneInspection(skill)]),
        ));
      }
      const projectCatalog = (projectId: string): Map<SkillId, SkillInspection> => {
        if (projectId.trim().length === 0 || !projects.has(projectId)) {
          throw new FakeSkillInstallationFailure(
            "skill-installation.invalid-project",
            `Project is not registered: ${projectId}`,
          );
        }
        return projects.get(projectId)!;
      };
      const mutate = (projectId: string, id: SkillId, installed: boolean) => {
        const catalog = projectCatalog(projectId);
        const current = catalog.get(id);
        if (!current) {
          throw new FakeSkillInstallationFailure(
            "skill-installation.unknown-skill",
            `Unknown skill: ${id}`,
          );
        }
        catalog.set(id, { ...current, installed });
        return { projectId, skillId: id, installed };
      };
      return Object.freeze({
        inspectSkills: operation(context, "inspect-skills", options, ({ projectId, catalog }) => (
          catalog.map((skill) => ({
            ...skill,
            installed: projectCatalog(projectId).get(skill.skillId)?.installed ?? false,
          }))
        )),
        installSkill: operation(context, "install-skill", options, ({ projectId, skill }) => {
          const catalog = projectCatalog(projectId);
          catalog.set(skill.skillId, { ...skill, installed: true });
          return { projectId, skillId: skill.skillId, installed: true };
        }),
        removeSkill: operation(context, "remove-skill", options, ({ projectId, skillId }) => (
          mutate(projectId, skillId, false)
        )),
      });
    },
  };
}
