import {
  MESSAGE_CONTRACT_SCHEMA_VERSION,
  MESSAGE_DIAGNOSTIC_CODES,
  MESSAGE_SERVICE_ERROR_CODES,
  MessageContractParseError,
  messagesService,
  parseDeliveryReceipt,
  parseMessageEnvelope,
  parsePublishReceipt,
  type DeliveryReceipt,
  type MessageEnvelope,
  type MessageServiceErrorCode,
  type ModuleId,
  type ModuleMessages,
  type PublishMessageInput,
  type PublishReceipt,
  type RequestMessageInput,
  type SemanticCorrelationId,
  type SemanticRequestOptions,
  type SemanticRequestOutcome,
  type SemanticResult,
  type SemanticServiceError,
  type SemanticServiceProvider,
  type SendMessageInput,
} from "@shipctl/module-api";

import { createSemanticRequestAdapter } from "./semanticServiceAdapter.ts";

/** Private, activation-bound bridge client. It exposes no Tauri command name. */
export interface ActivationMessageClient {
  send(envelope: MessageEnvelope): Promise<unknown>;
  publish(envelope: MessageEnvelope): Promise<unknown>;
  request(envelope: MessageEnvelope): Promise<unknown>;
}

export interface ActivationMessageClientBinding {
  readonly moduleId: ModuleId;
  readonly activationId: string;
  readonly client: ActivationMessageClient;
}

export interface MessagesServiceProviderOptions {
  readonly clientsByActivation: ReadonlyMap<string, ActivationMessageClientBinding>;
  readonly deactivateActivation: (activationId: string) => void;
}

type PrivateMessageRequest =
  | {
      readonly kind: "send";
      readonly input: SendMessageInput<unknown>;
    }
  | {
      readonly kind: "publish";
      readonly input: PublishMessageInput<unknown>;
    }
  | {
      readonly kind: "request";
      readonly input: RequestMessageInput<unknown, unknown>;
    };

const POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

const CANCELLED = failure(
  MESSAGE_SERVICE_ERROR_CODES.cancelled,
  "Message request was cancelled",
);
const DISPOSED = failure(
  MESSAGE_SERVICE_ERROR_CODES.activationDisposed,
  "The module activation is no longer active",
);

function failure(
  code: MessageServiceErrorCode,
  message: string,
): SemanticServiceError<MessageServiceErrorCode> {
  return { code, message, retryable: false };
}

function messageForCode(code: MessageServiceErrorCode): string {
  if (code === MESSAGE_SERVICE_ERROR_CODES.unavailable) {
    return "The runtime message service is unavailable";
  }
  if (code === MESSAGE_SERVICE_ERROR_CODES.invalidResponse) {
    return "The runtime message service returned an invalid response";
  }
  if (code === MESSAGE_SERVICE_ERROR_CODES.transportFailed) {
    return "The runtime message transport failed";
  }
  return "The runtime message request was rejected";
}

function transportError(error: unknown): SemanticServiceError<MessageServiceErrorCode> {
  if (error instanceof MessageContractParseError) {
    return failure(error.code, messageForCode(error.code));
  }
  const diagnostic = String(error);
  const knownCode = Object.values(MESSAGE_DIAGNOSTIC_CODES).find((code) =>
    diagnostic.includes(code));
  if (knownCode !== undefined) return failure(knownCode, messageForCode(knownCode));
  const code = /unknown command|not found/i.test(diagnostic)
    ? MESSAGE_SERVICE_ERROR_CODES.unavailable
    : MESSAGE_SERVICE_ERROR_CODES.transportFailed;
  return failure(code, messageForCode(code));
}

function envelope(
  endpoint: string,
  message: MessageEnvelope["message"],
  payload: unknown,
  correlationId: SemanticCorrelationId,
): MessageEnvelope {
  return parseMessageEnvelope({
    schemaVersion: MESSAGE_CONTRACT_SCHEMA_VERSION,
    endpoint,
    message,
    payload,
    correlationId,
  });
}

function sameMessage(
  actual: MessageEnvelope["message"],
  expected: MessageEnvelope["message"],
): boolean {
  return actual.id === expected.id && actual.version === expected.version;
}

function invalidResponse(): SemanticResult<never, MessageServiceErrorCode> {
  return {
    ok: false,
    error: failure(
      MESSAGE_SERVICE_ERROR_CODES.invalidResponse,
      messageForCode(MESSAGE_SERVICE_ERROR_CODES.invalidResponse),
    ),
  };
}

function operationResult<Value>(
  outcome: SemanticRequestOutcome<unknown, MessageServiceErrorCode>,
): SemanticRequestOutcome<Value, MessageServiceErrorCode> {
  return outcome as SemanticRequestOutcome<Value, MessageServiceErrorCode>;
}

/** Bind the existing native message graph behind the versioned semantic wall. */
export function createMessagesServiceProvider(
  options: MessagesServiceProviderOptions,
): SemanticServiceProvider<ModuleMessages> {
  return {
    service: messagesService,
    bind(context) {
      const binding = options.clientsByActivation.get(context.activation.activationId);
      if (
        binding === undefined
        || binding.activationId !== context.activation.activationId
        || binding.moduleId !== context.activation.moduleId
      ) {
        options.deactivateActivation(context.activation.activationId);
        throw new Error("The module activation has no admitted message bridge client");
      }
      context.own(() => {
        options.deactivateActivation(binding.activationId);
      });
      const request = createSemanticRequestAdapter<
        PrivateMessageRequest,
        unknown,
        MessageServiceErrorCode
      >({
        activation: context.activation,
        active: () => context.active,
        policy: POLICY,
        cancelledError: CANCELLED,
        disposedError: DISPOSED,
        transportError,
        transport: {
          async request(requestEnvelope) {
            const correlationId = requestEnvelope.correlationId;
            const request = requestEnvelope.input;
            if (request.kind === "send") {
              const wire = envelope(
                request.input.channel.id,
                request.input.channel.message,
                request.input.payload,
                correlationId,
              );
              const rawResponse = await binding.client.send(wire);
              let response: DeliveryReceipt;
              try {
                response = parseDeliveryReceipt(rawResponse);
              } catch {
                return invalidResponse();
              }
              if (
                response.endpoint !== wire.endpoint
                || !sameMessage(response.message, wire.message)
              ) return invalidResponse();
              return { ok: true, value: response };
            }
            if (request.kind === "publish") {
              const wire = envelope(
                request.input.topic.id,
                request.input.topic.message,
                request.input.payload,
                correlationId,
              );
              const rawResponse = await binding.client.publish(wire);
              let response: PublishReceipt;
              try {
                response = parsePublishReceipt(rawResponse);
              } catch {
                return invalidResponse();
              }
              if (
                response.endpoint !== wire.endpoint
                || !sameMessage(response.message, wire.message)
              ) return invalidResponse();
              return { ok: true, value: response };
            }
            const wire = envelope(
              request.input.port.id,
              request.input.port.request,
              request.input.payload,
              correlationId,
            );
            const rawResponse = await binding.client.request(wire);
            let response: MessageEnvelope;
            try {
              response = parseMessageEnvelope(rawResponse);
            } catch {
              return invalidResponse();
            }
            if (
              response.endpoint !== wire.endpoint
              || !sameMessage(response.message, request.input.port.response)
              || (
                response.correlationId !== undefined
                && response.correlationId !== correlationId
              )
            ) return invalidResponse();
            return { ok: true, value: response.payload };
          },
        },
      });
      const service: ModuleMessages = {
        sendMessage: Object.freeze({
          policy: request.policy,
          execute<Payload>(
            input: SendMessageInput<Payload>,
            requestOptions?: SemanticRequestOptions,
          ): Promise<SemanticRequestOutcome<DeliveryReceipt, MessageServiceErrorCode>> {
            return request.execute(
              { kind: "send", input: input as SendMessageInput<unknown> },
              requestOptions,
            ).then(operationResult<DeliveryReceipt>);
          },
        }),
        publishMessage: Object.freeze({
          policy: request.policy,
          execute<Payload>(
            input: PublishMessageInput<Payload>,
            requestOptions?: SemanticRequestOptions,
          ): Promise<SemanticRequestOutcome<PublishReceipt, MessageServiceErrorCode>> {
            return request.execute(
              { kind: "publish", input: input as PublishMessageInput<unknown> },
              requestOptions,
            ).then(operationResult<PublishReceipt>);
          },
        }),
        requestMessage: Object.freeze({
          policy: request.policy,
          execute<Request, Response>(
            input: RequestMessageInput<Request, Response>,
            requestOptions?: SemanticRequestOptions,
          ): Promise<SemanticRequestOutcome<Response, MessageServiceErrorCode>> {
            return request.execute(
              {
                kind: "request",
                input: input as RequestMessageInput<unknown, unknown>,
              },
              requestOptions,
            ).then(operationResult<Response>);
          },
        }),
      };
      return Object.freeze(service);
    },
  };
}
