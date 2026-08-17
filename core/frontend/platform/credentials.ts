import { invoke } from "@tauri-apps/api/core";
import {
  credentialStoreService,
  type CredentialGrant,
  type CredentialId,
  type CredentialStatus,
  type CredentialStoreErrorCode,
  type CredentialStoreService,
  type DeleteCredentialInput,
  type InspectCredentialInput,
  type ModuleActivationIdentity,
  type SaveCredentialInput,
  type SemanticCorrelationId,
  type SemanticServiceError,
  type SemanticServiceProvider,
  type SemanticServiceProviderContext,
} from "@shipctl/module-api";

import {
  createSemanticRequestAdapter,
  type PrivateSemanticRequestEnvelope,
  type PrivateSemanticRequestTransport,
} from "./semanticServiceAdapter.ts";

const COMMANDS = {
  inspect: "inspect_credential",
  save: "save_credential",
  delete: "delete_credential",
  release: "release_credential_store_activation",
} as const;

const PI_API_KEY_PREFIX = "pi.api-key:";

export interface CredentialStoreTransport {
  hasCredential(
    request: PrivateSemanticRequestEnvelope<InspectCredentialInput>,
  ): Promise<boolean>;
  saveCredential(
    request: PrivateSemanticRequestEnvelope<SaveCredentialInput>,
  ): Promise<void>;
  deleteCredential(
    request: PrivateSemanticRequestEnvelope<DeleteCredentialInput>,
  ): Promise<void>;
  releaseActivation(
    request: PrivateSemanticRequestEnvelope<Readonly<Record<never, never>>>,
  ): Promise<boolean>;
}

export interface CredentialAuthorizationRequest {
  readonly activation: ModuleActivationIdentity;
  readonly grant: CredentialGrant;
  readonly credentialId: CredentialId;
}

export type CredentialAuthorizer = (request: CredentialAuthorizationRequest) => boolean;

export interface CredentialStoreServiceProviderOptions {
  readonly transport?: CredentialStoreTransport;
  readonly authorize?: CredentialAuthorizer;
  readonly createCorrelationId?: () => SemanticCorrelationId;
}

function piProvider(id: CredentialId): string | null {
  if (!id.startsWith(PI_API_KEY_PREFIX)) return null;
  const provider = id.slice(PI_API_KEY_PREFIX.length);
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(provider) ? provider : null;
}

const TAURI_TRANSPORT: CredentialStoreTransport = {
  hasCredential: (request) => invoke(COMMANDS.inspect, { request }),
  saveCredential: (request) => invoke(COMMANDS.save, { request }),
  deleteCredential: (request) => invoke(COMMANDS.delete, { request }),
  releaseActivation: (request) => invoke(COMMANDS.release, { request }),
};

const DEFAULT_AUTHORIZE: CredentialAuthorizer = ({ activation, grant, credentialId }) => (
  activation.moduleId === "shipctl.assistants"
  && (grant === "credential.inspect" || grant === "credential.write")
  && piProvider(credentialId) !== null
);

const REQUEST_POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

const CANCELLED_ERROR = {
  code: "credential-store.cancelled",
  message: "Credential request was cancelled",
  retryable: false,
} as const;

const DISPOSED_ERROR = {
  code: "credential-store.activation-disposed",
  message: "The module activation is no longer active",
  retryable: false,
} as const;

function correlationId(): SemanticCorrelationId {
  return crypto.randomUUID() as SemanticCorrelationId;
}

function transportError(
  error: unknown,
): SemanticServiceError<CredentialStoreErrorCode> {
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    && [
      "credential-store.transport-failed",
      "credential-store.denied",
      "credential-store.invalid-request",
      "credential-store.unavailable",
      "credential-store.cancelled",
      "credential-store.activation-disposed",
    ].includes(error.code)
  ) {
    return {
      code: error.code as CredentialStoreErrorCode,
      message: "Credential-store request failed",
      retryable: "retryable" in error && error.retryable === true,
    };
  }
  const normalized = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const code: CredentialStoreErrorCode = normalized.includes("permission")
    || normalized.includes("denied")
    || normalized.includes("not allowed")
    ? "credential-store.denied"
    : normalized.includes("not found") || normalized.includes("unknown command")
      ? "credential-store.unavailable"
      : "credential-store.transport-failed";
  return {
    code,
    message: code === "credential-store.denied"
      ? "Credential access was denied"
      : code === "credential-store.unavailable"
        ? "Credential storage is unavailable"
        : "Credential storage failed",
    retryable: false,
  };
}

function request<Input, Output>(
  context: SemanticServiceProviderContext,
  transport: PrivateSemanticRequestTransport<Input, Output, CredentialStoreErrorCode>,
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

function failure(code: CredentialStoreErrorCode, message: string) {
  return { ok: false, error: { code, message, retryable: false } } as const;
}

function validate(
  context: SemanticServiceProviderContext,
  authorize: CredentialAuthorizer,
  grant: CredentialGrant,
  id: CredentialId,
) {
  if (piProvider(id) === null) {
    return failure("credential-store.invalid-request", "Credential identity is invalid");
  }
  if (!authorize({ activation: context.activation, grant, credentialId: id })) {
    return failure("credential-store.denied", "Credential access was denied");
  }
  return null;
}

/** Trusted adapter for the current Pi credential commands. */
export function createCredentialStoreServiceProvider(
  options: CredentialStoreServiceProviderOptions = {},
): SemanticServiceProvider<CredentialStoreService> {
  const transport = options.transport ?? TAURI_TRANSPORT;
  const authorize = options.authorize ?? DEFAULT_AUTHORIZE;
  const createCorrelationId = options.createCorrelationId ?? correlationId;
  return {
    service: credentialStoreService,
    bind(context) {
      context.own(() => transport.releaseActivation({
        activation: context.activation,
        correlationId: createCorrelationId(),
        input: {},
      }).then(() => undefined));
      return Object.freeze({
        hasCredential: request<InspectCredentialInput, CredentialStatus>(context, {
          async request(envelope) {
            const denied = validate(
              context,
              authorize,
              "credential.inspect",
              envelope.input.credentialId,
            );
            if (denied) return denied;
            const configured = await transport.hasCredential(envelope);
            return {
              ok: true,
              value: { credentialId: envelope.input.credentialId, configured },
            };
          },
        }),
        saveCredential: request<SaveCredentialInput, CredentialStatus>(context, {
          async request(envelope) {
            const denied = validate(
              context,
              authorize,
              "credential.write",
              envelope.input.credentialId,
            );
            if (denied) return denied;
            if (envelope.input.secret.length === 0) {
              return failure(
                "credential-store.invalid-request",
                "Credential secret cannot be empty",
              );
            }
            await transport.saveCredential(envelope);
            return {
              ok: true,
              value: { credentialId: envelope.input.credentialId, configured: true },
            };
          },
        }),
        deleteCredential: request<DeleteCredentialInput, CredentialStatus>(context, {
          async request(envelope) {
            const denied = validate(
              context,
              authorize,
              "credential.write",
              envelope.input.credentialId,
            );
            if (denied) return denied;
            await transport.deleteCredential(envelope);
            return {
              ok: true,
              value: { credentialId: envelope.input.credentialId, configured: false },
            };
          },
        }),
      });
    },
  };
}
