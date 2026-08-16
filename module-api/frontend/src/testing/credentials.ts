import {
  credentialStoreService,
  type CredentialGrant,
  type CredentialId,
  type CredentialStatus,
  type CredentialStoreErrorCode,
  type CredentialStoreService,
  type SaveCredentialInput,
} from "../protocol/credentials";
import type {
  SemanticCorrelationId,
  SemanticRequestOperation,
  SemanticServiceError,
} from "../protocol/semanticServices";
import type {
  SemanticServiceProvider,
  SemanticServiceProviderContext,
} from "../host/semanticServices";

import { createFakeRequestOperation } from "./semanticServices";

export type FakeCredentialOperation =
  | "has-credential"
  | "save-credential"
  | "delete-credential";

export interface FakeCredentialTrace {
  readonly operation: FakeCredentialOperation;
  readonly activation: SemanticServiceProviderContext["activation"];
  readonly correlationId: SemanticCorrelationId;
  readonly credentialId: CredentialId;
  readonly secret?: "[REDACTED]";
}

export interface FakeCredentialStoreProviderOptions {
  readonly configuredCredentials?: readonly CredentialId[];
  readonly deniedGrants?: readonly CredentialGrant[];
  readonly trace?: FakeCredentialTrace[];
}

class FakeCredentialFailure extends Error {
  readonly code: CredentialStoreErrorCode;

  constructor(code: CredentialStoreErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

const CANCELLED = {
  code: "credential-store.cancelled",
  message: "Credential request was cancelled",
  retryable: false,
} as const;

const DISPOSED = {
  code: "credential-store.activation-disposed",
  message: "The module activation is no longer active",
  retryable: false,
} as const;

function failedError(
  error: unknown,
): SemanticServiceError<CredentialStoreErrorCode> {
  if (error instanceof FakeCredentialFailure) {
    return { code: error.code, message: error.message, retryable: false };
  }
  return {
    code: "credential-store.transport-failed",
    message: "The fake credential provider failed",
    retryable: false,
  };
}

function operation<Input extends { readonly credentialId: CredentialId }>(
  context: SemanticServiceProviderContext,
  name: FakeCredentialOperation,
  grant: CredentialGrant,
  options: FakeCredentialStoreProviderOptions,
  handle: (input: Input) => CredentialStatus,
): SemanticRequestOperation<Input, CredentialStatus, CredentialStoreErrorCode> {
  return createFakeRequestOperation({
    context,
    policy: POLICY,
    handle: (request) => {
      options.trace?.push({
        operation: name,
        activation: request.activation,
        correlationId: request.correlationId,
        credentialId: request.input.credentialId,
        ...(name === "save-credential" ? { secret: "[REDACTED]" as const } : {}),
      });
      if (options.deniedGrants?.includes(grant)) {
        throw new FakeCredentialFailure(
          "credential-store.denied",
          `Fake credential grant denied: ${grant}`,
        );
      }
      return handle(request.input);
    },
    failedError,
    cancelledError: CANCELLED,
    disposedError: DISPOSED,
  });
}

/** Test-only store that records availability and redacted request metadata. */
export function createFakeCredentialStoreServiceProvider(
  options: FakeCredentialStoreProviderOptions = {},
): SemanticServiceProvider<CredentialStoreService> {
  return {
    service: credentialStoreService,
    bind(context) {
      const configured = new Set(options.configuredCredentials ?? []);
      const status = (id: CredentialId): CredentialStatus => ({
        credentialId: id,
        configured: configured.has(id),
      });
      return Object.freeze({
        hasCredential: operation(context, "has-credential", "credential.inspect", options, (
          { credentialId: id },
        ) => status(id)),
        saveCredential: operation<SaveCredentialInput>(
          context,
          "save-credential",
          "credential.write",
          options,
          ({ credentialId: id, secret }) => {
            if (secret.length === 0) {
              throw new FakeCredentialFailure(
                "credential-store.invalid-request",
                "Credential secret cannot be empty",
              );
            }
            configured.add(id);
            return status(id);
          },
        ),
        deleteCredential: operation(context, "delete-credential", "credential.write", options, (
          { credentialId: id },
        ) => {
          configured.delete(id);
          return status(id);
        }),
      });
    },
  };
}
