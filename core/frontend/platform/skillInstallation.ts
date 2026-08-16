import { invoke } from "@tauri-apps/api/core";
import {
  skillId,
  skillInstallationService,
  type InspectSkillsInput,
  type SemanticServiceError,
  type SemanticServiceProvider,
  type SemanticServiceProviderContext,
  type SkillInspection,
  type SkillInstallationErrorCode,
  type SkillInstallationService,
  type SkillMutationInput,
  type SkillMutationReceipt,
} from "@shipctl/module-api";

import {
  createSemanticRequestAdapter,
  type PrivateSemanticRequestEnvelope,
  type PrivateSemanticRequestTransport,
} from "./semanticServiceAdapter.ts";

const COMMANDS = {
  inspect: "plugin:shipctl-skills|list_skills",
  install: "plugin:shipctl-skills|setup_skill",
  remove: "plugin:shipctl-skills|remove_skill",
} as const;

interface LegacySkillInfo {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly installed: boolean;
}

export interface LegacySkillInstallationTransport {
  inspectSkills(
    request: PrivateSemanticRequestEnvelope<InspectSkillsInput>,
  ): Promise<readonly LegacySkillInfo[]>;
  installSkill(request: PrivateSemanticRequestEnvelope<SkillMutationInput>): Promise<void>;
  removeSkill(request: PrivateSemanticRequestEnvelope<SkillMutationInput>): Promise<void>;
}

export interface SkillInstallationServiceProviderOptions {
  readonly transport?: LegacySkillInstallationTransport;
}

const TAURI_TRANSPORT: LegacySkillInstallationTransport = {
  inspectSkills: ({ input }) => invoke(COMMANDS.inspect, { repoPath: input.projectId }),
  installSkill: ({ input }) => invoke(COMMANDS.install, {
    repoPath: input.projectId,
    name: input.skillId,
  }),
  removeSkill: ({ input }) => invoke(COMMANDS.remove, {
    repoPath: input.projectId,
    name: input.skillId,
  }),
};

const REQUEST_POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

const CANCELLED_ERROR = {
  code: "skill-installation.cancelled",
  message: "Skill request was cancelled",
  retryable: false,
} as const;

const DISPOSED_ERROR = {
  code: "skill-installation.activation-disposed",
  message: "The module activation is no longer active",
  retryable: false,
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function transportError(
  error: unknown,
): SemanticServiceError<SkillInstallationErrorCode> {
  const message = errorMessage(error);
  const normalized = message.toLowerCase();
  const code: SkillInstallationErrorCode = normalized.includes("project is not registered")
    || normalized.includes("not a directory")
    ? "skill-installation.invalid-project"
    : normalized.includes("unknown skill")
      ? "skill-installation.unknown-skill"
      : normalized.includes("permission")
        || normalized.includes("denied")
        || normalized.includes("not permitted")
        || normalized.includes("not allowed")
        ? "skill-installation.denied"
        : "skill-installation.transport-failed";
  return { code, message, retryable: false };
}

function request<Input, Output>(
  context: SemanticServiceProviderContext,
  transport: PrivateSemanticRequestTransport<
    Input,
    Output,
    SkillInstallationErrorCode
  >,
) {
  return createSemanticRequestAdapter({
    activation: context.activation,
    active: () => context.active,
    policy: REQUEST_POLICY,
    transport,
    transportError,
    cancelledError: CANCELLED_ERROR,
    disposedError: DISPOSED_ERROR,
  });
}

function invalidRequest(code: SkillInstallationErrorCode, message: string) {
  return { ok: false, error: { code, message, retryable: false } } as const;
}

function validProject(projectId: string): boolean {
  return projectId.trim().length > 0;
}

function inspectRequest(
  context: SemanticServiceProviderContext,
  transport: LegacySkillInstallationTransport,
) {
  return request<InspectSkillsInput, readonly SkillInspection[]>(context, {
    async request(envelope) {
      if (!validProject(envelope.input.projectId)) {
        return invalidRequest(
          "skill-installation.invalid-project",
          "Project identity cannot be empty",
        );
      }
      const rawSkills = await transport.inspectSkills(envelope);
      try {
        return {
          ok: true,
          value: rawSkills.map((raw): SkillInspection => ({
            skillId: skillId(raw.name),
            title: raw.title,
            description: raw.description,
            installed: raw.installed,
          })),
        };
      } catch (error) {
        return invalidRequest("skill-installation.invalid-request", errorMessage(error));
      }
    },
  });
}

function mutationRequest(
  context: SemanticServiceProviderContext,
  installed: boolean,
  dispatch: (
    envelope: PrivateSemanticRequestEnvelope<SkillMutationInput>,
  ) => Promise<void>,
) {
  return request<SkillMutationInput, SkillMutationReceipt>(context, {
    async request(envelope) {
      if (!validProject(envelope.input.projectId)) {
        return invalidRequest(
          "skill-installation.invalid-project",
          "Project identity cannot be empty",
        );
      }
      try {
        skillId(envelope.input.skillId);
      } catch (error) {
        return invalidRequest("skill-installation.invalid-request", errorMessage(error));
      }
      await dispatch(envelope);
      return { ok: true, value: { ...envelope.input, installed } };
    },
  });
}

/** Trusted adapter for the current namespaced Skills commands. */
export function createSkillInstallationServiceProvider(
  options: SkillInstallationServiceProviderOptions = {},
): SemanticServiceProvider<SkillInstallationService> {
  const transport = options.transport ?? TAURI_TRANSPORT;
  return {
    service: skillInstallationService,
    bind(context) {
      return Object.freeze({
        inspectSkills: inspectRequest(context, transport),
        installSkill: mutationRequest(context, true, transport.installSkill),
        removeSkill: mutationRequest(context, false, transport.removeSkill),
      });
    },
  };
}
