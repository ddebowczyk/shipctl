import {
  credentialId,
  credentialStoreService,
  type CredentialStoreErrorCode,
  type CredentialStoreService,
  type ModuleActivationContext,
  type SemanticRequestOperation,
} from "@shipctl/module-api";

const PI_API_KEY_NAMESPACE = "pi.api-key";

export class CredentialStoreClientError extends Error {
  readonly code: CredentialStoreErrorCode;

  constructor(code: CredentialStoreErrorCode, message: string) {
    super(message);
    this.name = "CredentialStoreClientError";
    this.code = code;
  }
}

async function execute<Input, Output>(
  operation: SemanticRequestOperation<Input, Output, CredentialStoreErrorCode>,
  input: Input,
): Promise<Output> {
  const outcome = await operation.execute(input);
  if (!outcome.result.ok) {
    throw new CredentialStoreClientError(
      outcome.result.error.code,
      outcome.result.error.message,
    );
  }
  return outcome.result.value;
}

export interface PiCredentialClient {
  hasApiKey(provider: string): Promise<boolean>;
  saveApiKey(provider: string, secret: string): Promise<void>;
  deleteApiKey(provider: string): Promise<void>;
}

export function createPiCredentialClient(
  service: CredentialStoreService,
): PiCredentialClient {
  const client: PiCredentialClient = {
    hasApiKey: async (provider) => (
      await execute(service.hasCredential, {
        credentialId: credentialId(PI_API_KEY_NAMESPACE, provider),
      })
    ).configured,
    saveApiKey: async (provider, secret) => {
      await execute(service.saveCredential, {
        credentialId: credentialId(PI_API_KEY_NAMESPACE, provider),
        secret,
      });
    },
    deleteApiKey: async (provider) => {
      await execute(service.deleteCredential, {
        credentialId: credentialId(PI_API_KEY_NAMESPACE, provider),
      });
    },
  };
  return Object.freeze(client);
}

export function piCredentialClientFor(
  activation: ModuleActivationContext,
): PiCredentialClient {
  return createPiCredentialClient(activation.services.require(credentialStoreService));
}
