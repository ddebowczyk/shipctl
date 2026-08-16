import type {
  ModuleActivationIdentity,
  SemanticCancellation,
  SemanticCorrelationId,
  SemanticRequestOperation,
  SemanticRequestPolicy,
  SemanticResult,
  SemanticServiceError,
} from "@shipctl/module-api";

export interface PrivateSemanticRequestEnvelope<Input> {
  readonly activation: ModuleActivationIdentity;
  readonly correlationId: SemanticCorrelationId;
  readonly input: Input;
}

export interface PrivateSemanticRequestTransport<Input, Output, ErrorCode extends string> {
  request(
    envelope: PrivateSemanticRequestEnvelope<Input>,
    cancellation?: SemanticCancellation,
  ): Promise<SemanticResult<Output, ErrorCode>>;
}

export interface SemanticRequestAdapterOptions<Input, Output, ErrorCode extends string> {
  readonly activation: ModuleActivationIdentity;
  readonly active: () => boolean;
  readonly policy: SemanticRequestPolicy;
  readonly transport: PrivateSemanticRequestTransport<Input, Output, ErrorCode>;
  readonly correlationId?: () => SemanticCorrelationId;
  readonly transportError: (error: unknown) => SemanticServiceError<ErrorCode>;
  readonly cancelledError: SemanticServiceError<ErrorCode>;
  readonly disposedError: SemanticServiceError<ErrorCode>;
}

function defaultCorrelationId(): SemanticCorrelationId {
  return crypto.randomUUID() as SemanticCorrelationId;
}

/**
 * Bind one semantic operation to one activation before it can reach a private
 * transport. This adapter exposes no command name or generic dispatch method.
 */
export function createSemanticRequestAdapter<
  Input,
  Output,
  ErrorCode extends string,
>(
  options: SemanticRequestAdapterOptions<Input, Output, ErrorCode>,
): SemanticRequestOperation<Input, Output, ErrorCode> {
  const createCorrelationId = options.correlationId ?? defaultCorrelationId;
  const operation: SemanticRequestOperation<Input, Output, ErrorCode> = {
    policy: options.policy,
    async execute(input, requestOptions) {
      const correlationId = createCorrelationId();
      if (!options.active()) {
        return { correlationId, result: { ok: false, error: options.disposedError } };
      }
      if (
        requestOptions?.cancellation?.cancelled
        && options.policy.cancellation !== "unsupported"
      ) {
        return { correlationId, result: { ok: false, error: options.cancelledError } };
      }
      try {
        const result = await options.transport.request(
          { activation: options.activation, correlationId, input },
          requestOptions?.cancellation,
        );
        return { correlationId, result };
      } catch (error) {
        return {
          correlationId,
          result: { ok: false, error: options.transportError(error) },
        };
      }
    },
  };
  return Object.freeze(operation);
}
