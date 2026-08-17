import { invoke } from "@tauri-apps/api/core";
import {
  skillId,
  skillInstallationService,
  type InstallSkillInput,
  type InspectSkillsInput,
  type ModuleActivationIdentity,
  type RemoveSkillInput,
  type SemanticCorrelationId,
  type SemanticServiceError,
  type SemanticServiceProvider,
  type SemanticServiceProviderContext,
  type SkillInspection,
  type SkillInstallationErrorCode,
  type SkillInstallationService,
  type SkillMutationReceipt,
} from "@shipctl/module-api";

import {
  createSemanticRequestAdapter,
  type PrivateSemanticRequestEnvelope,
  type PrivateSemanticRequestTransport,
} from "./semanticServiceAdapter.ts";

const COMMANDS = {
  inspect: "inspect_skill_installations",
  install: "install_skill_source",
  remove: "remove_skill_installation",
  release: "release_skill_installation_activation",
} as const;

interface NativeSkillInstallationState {
  readonly skillId: string;
  readonly installed: boolean;
}

interface NativeInspectSkillInstallationsInput {
  readonly projectId: string;
  readonly skillIds: readonly string[];
}

interface NativeInstallSkillSourceInput {
  readonly projectId: string;
  readonly skillId: string;
  readonly markdown: string;
}

type EmptyInput = Readonly<Record<never, never>>;

/** Private transport seam used by the production adapter and property tests. */
export interface NativeSkillInstallationTransport {
  inspectInstallations(
    request: PrivateSemanticRequestEnvelope<NativeInspectSkillInstallationsInput>,
  ): Promise<readonly NativeSkillInstallationState[]>;
  installSource(
    request: PrivateSemanticRequestEnvelope<NativeInstallSkillSourceInput>,
  ): Promise<void>;
  removeInstallation(
    request: PrivateSemanticRequestEnvelope<RemoveSkillInput>,
  ): Promise<void>;
  releaseActivation(
    request: PrivateSemanticRequestEnvelope<EmptyInput>,
  ): Promise<void>;
}

export interface SkillInstallationServiceProviderOptions {
  readonly transport?: NativeSkillInstallationTransport;
  readonly createCorrelationId?: () => SemanticCorrelationId;
}

const TAURI_TRANSPORT: NativeSkillInstallationTransport = {
  inspectInstallations: (request) => invoke(COMMANDS.inspect, { request }),
  installSource: (request) => invoke(COMMANDS.install, { request }),
  removeInstallation: (request) => invoke(COMMANDS.remove, { request }),
  releaseActivation: (request) => invoke(COMMANDS.release, { request }),
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

function correlationId(): SemanticCorrelationId {
  return crypto.randomUUID() as SemanticCorrelationId;
}

function isSkillInstallationErrorCode(value: unknown): value is SkillInstallationErrorCode {
  return typeof value === "string" && [
    "skill-installation.transport-failed",
    "skill-installation.denied",
    "skill-installation.invalid-project",
    "skill-installation.unknown-skill",
    "skill-installation.invalid-request",
    "skill-installation.cancelled",
    "skill-installation.activation-disposed",
  ].includes(value);
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return error instanceof Error ? error.message : String(error);
}

function transportError(
  error: unknown,
): SemanticServiceError<SkillInstallationErrorCode> {
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && isSkillInstallationErrorCode(error.code)
  ) {
    return {
      code: error.code,
      message: errorMessage(error),
      retryable: "retryable" in error && error.retryable === true,
    };
  }
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
  transport: PrivateSemanticRequestTransport<Input, Output, SkillInstallationErrorCode>,
  createCorrelationId: () => SemanticCorrelationId,
) {
  return createSemanticRequestAdapter({
    activation: context.activation,
    active: () => context.active,
    policy: REQUEST_POLICY,
    transport,
    correlationId: createCorrelationId,
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

function releaseEnvelope(
  activation: ModuleActivationIdentity,
  createCorrelationId: () => SemanticCorrelationId,
): PrivateSemanticRequestEnvelope<EmptyInput> {
  return { activation, correlationId: createCorrelationId(), input: {} };
}

function inspectRequest(
  context: SemanticServiceProviderContext,
  transport: NativeSkillInstallationTransport,
  createCorrelationId: () => SemanticCorrelationId,
) {
  return request<InspectSkillsInput, readonly SkillInspection[]>(context, {
    async request(envelope) {
      if (!validProject(envelope.input.projectId)) {
        return invalidRequest(
          "skill-installation.invalid-project",
          "Project identity cannot be empty",
        );
      }
      const seen = new Set<string>();
      try {
        for (const descriptor of envelope.input.catalog) {
          skillId(descriptor.skillId);
          if (seen.has(descriptor.skillId)) throw new Error("Duplicate skill identity");
          seen.add(descriptor.skillId);
        }
      } catch (error) {
        return invalidRequest("skill-installation.invalid-request", errorMessage(error));
      }
      const states = await transport.inspectInstallations({
        ...envelope,
        input: {
          projectId: envelope.input.projectId,
          skillIds: envelope.input.catalog.map(({ skillId: id }) => id),
        },
      });
      const stateById = new Map(states.map((state) => [state.skillId, state.installed]));
      if (stateById.size !== states.length || stateById.size !== envelope.input.catalog.length) {
        return invalidRequest(
          "skill-installation.invalid-request",
          "Native skill inspection did not match the requested catalog",
        );
      }
      try {
        return {
          ok: true,
          value: envelope.input.catalog.map((descriptor): SkillInspection => ({
            ...descriptor,
            installed: stateById.get(descriptor.skillId) ?? (() => {
              throw new Error(`Missing native skill state: ${descriptor.skillId}`);
            })(),
          })),
        };
      } catch (error) {
        return invalidRequest("skill-installation.invalid-request", errorMessage(error));
      }
    },
  }, createCorrelationId);
}

function installRequest(
  context: SemanticServiceProviderContext,
  transport: NativeSkillInstallationTransport,
  createCorrelationId: () => SemanticCorrelationId,
) {
  return request<InstallSkillInput, SkillMutationReceipt>(context, {
    async request(envelope) {
      if (!validProject(envelope.input.projectId)) {
        return invalidRequest(
          "skill-installation.invalid-project",
          "Project identity cannot be empty",
        );
      }
      try {
        skillId(envelope.input.skill.skillId);
      } catch (error) {
        return invalidRequest("skill-installation.invalid-request", errorMessage(error));
      }
      await transport.installSource({
        ...envelope,
        input: {
          projectId: envelope.input.projectId,
          skillId: envelope.input.skill.skillId,
          markdown: envelope.input.skill.markdown,
        },
      });
      return {
        ok: true,
        value: {
          projectId: envelope.input.projectId,
          skillId: envelope.input.skill.skillId,
          installed: true,
        },
      };
    },
  }, createCorrelationId);
}

function removeRequest(
  context: SemanticServiceProviderContext,
  transport: NativeSkillInstallationTransport,
  createCorrelationId: () => SemanticCorrelationId,
) {
  return request<RemoveSkillInput, SkillMutationReceipt>(context, {
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
      await transport.removeInstallation(envelope);
      return { ok: true, value: { ...envelope.input, installed: false } };
    },
  }, createCorrelationId);
}

/** Trusted adapter for the permanent native Skill Installation provider. */
export function createSkillInstallationServiceProvider(
  options: SkillInstallationServiceProviderOptions = {},
): SemanticServiceProvider<SkillInstallationService> {
  const transport = options.transport ?? TAURI_TRANSPORT;
  const createCorrelationId = options.createCorrelationId ?? correlationId;
  return {
    service: skillInstallationService,
    bind(context) {
      context.own(() => transport.releaseActivation(
        releaseEnvelope(context.activation, createCorrelationId),
      ));
      return Object.freeze({
        inspectSkills: inspectRequest(context, transport, createCorrelationId),
        installSkill: installRequest(context, transport, createCorrelationId),
        removeSkill: removeRequest(context, transport, createCorrelationId),
      });
    },
  };
}
