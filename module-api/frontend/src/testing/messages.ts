import {
  MESSAGE_CONTRACT_SCHEMA_VERSION,
  MESSAGE_DIAGNOSTIC_CODES,
  MESSAGE_SERVICE_ERROR_CODES,
  messagesService,
  parseMessageEnvelope,
  type BroadcastMessageSubscription,
  type DeliveryReceipt,
  type DirectedMessageHandler,
  type MessageEnvelope,
  type MessageRef,
  type MessageServiceErrorCode,
  type MessageTypeContract,
  type ModuleMessageContributions,
  type ModuleMessages,
  type PublishMessageInput,
  type PublishReceipt,
  type RequestMessageInput,
  type SendMessageInput,
} from "../protocol/messages.ts";
import type {
  ModuleActivationIdentity,
  SemanticCorrelationId,
  SemanticRequestOptions,
  SemanticRequestOutcome,
  SemanticServiceError,
} from "../protocol/semanticServices.ts";
import type { SemanticServiceProvider } from "../host/semanticServices.ts";
import { createFakeRequestOperation, type FakeRequestTrace } from "./semanticServices.ts";

export interface FakeMessageRegistration {
  readonly activation: ModuleActivationIdentity;
  readonly grants: readonly string[];
  readonly messages: ModuleMessageContributions;
}

export type FakeMessageOperation = "send" | "publish" | "request";

export interface FakeMessageTrace {
  readonly operation: FakeMessageOperation;
  readonly activation: ModuleActivationIdentity;
  readonly correlationId: SemanticCorrelationId;
  readonly envelope: MessageEnvelope;
}

export interface FakeMessagesProviderOptions {
  readonly registrations: readonly FakeMessageRegistration[];
  readonly trace?: FakeMessageTrace[];
  readonly routeGeneration?: number;
}

type FakeRequest =
  | { readonly kind: "send"; readonly input: SendMessageInput<unknown> }
  | { readonly kind: "publish"; readonly input: PublishMessageInput<unknown> }
  | { readonly kind: "request"; readonly input: RequestMessageInput<unknown, unknown> };

class FakeMessageError extends Error {
  constructor(readonly code: MessageServiceErrorCode) {
    super("The fake runtime message request was rejected");
  }
}

const POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

const CANCELLED = error(
  MESSAGE_SERVICE_ERROR_CODES.cancelled,
  "Message request was cancelled",
);
const DISPOSED = error(
  MESSAGE_SERVICE_ERROR_CODES.activationDisposed,
  "The module activation is no longer active",
);

function error(
  code: MessageServiceErrorCode,
  message = "The fake runtime message request was rejected",
): SemanticServiceError<MessageServiceErrorCode> {
  return { code, message, retryable: false };
}

function failed(errorValue: unknown): SemanticServiceError<MessageServiceErrorCode> {
  return error(
    errorValue instanceof FakeMessageError
      ? errorValue.code
      : MESSAGE_SERVICE_ERROR_CODES.transportFailed,
  );
}

function key(message: MessageRef<unknown>): string {
  return `${message.id}@${message.version}`;
}

function registrationKey(identity: ModuleActivationIdentity): string {
  return `${identity.moduleId}\u001f${identity.activationId}`;
}

function sameIdentity(
  left: ModuleActivationIdentity,
  right: ModuleActivationIdentity,
): boolean {
  return left.moduleId === right.moduleId && left.activationId === right.activationId;
}

function wireEnvelope(
  endpoint: string,
  message: MessageRef<unknown>,
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

function encodedBytes(value: unknown): number {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new FakeMessageError(MESSAGE_DIAGNOSTIC_CODES.invalidJson);
  }
  if (encoded === undefined) {
    throw new FakeMessageError(MESSAGE_DIAGNOSTIC_CODES.invalidJson);
  }
  return new TextEncoder().encode(encoded).byteLength;
}

function contractFor(
  registrations: readonly FakeMessageRegistration[],
  message: MessageRef<unknown>,
): MessageTypeContract<unknown> {
  const contracts = registrations.flatMap(({ messages }) => messages.provides ?? [])
    .filter((contract) => key(contract.message) === key(message));
  if (contracts.length === 0) {
    throw new FakeMessageError(MESSAGE_DIAGNOSTIC_CODES.unknownMessageContract);
  }
  return contracts[0];
}

function validateBound(
  registrations: readonly FakeMessageRegistration[],
  envelope: MessageEnvelope,
): void {
  const contract = contractFor(registrations, envelope.message);
  if (encodedBytes(envelope.payload) > contract.schema.maxEncodedBytes) {
    throw new FakeMessageError(MESSAGE_DIAGNOSTIC_CODES.payloadTooLarge);
  }
}

function authorize(registration: FakeMessageRegistration, grant: string): void {
  if (!registration.grants.includes(grant)) {
    throw new FakeMessageError(MESSAGE_DIAGNOSTIC_CODES.unauthorizedSender);
  }
}

function unique<Value>(values: readonly Value[]): Value {
  if (values.length === 0) {
    throw new FakeMessageError(MESSAGE_DIAGNOSTIC_CODES.noActiveChannelOwner);
  }
  if (values.length > 1) {
    throw new FakeMessageError(MESSAGE_DIAGNOSTIC_CODES.duplicateChannelOwner);
  }
  return values[0];
}

function outcome<Value>(
  requestOutcome: SemanticRequestOutcome<unknown, MessageServiceErrorCode>,
): SemanticRequestOutcome<Value, MessageServiceErrorCode> {
  return requestOutcome as SemanticRequestOutcome<Value, MessageServiceErrorCode>;
}

/**
 * Tauri-free message graph for plugin workflow tests. Registrations are exact
 * activation records; disposal removes their routes before later dispatch.
 */
export function createFakeMessagesServiceProvider(
  options: FakeMessagesProviderOptions,
): SemanticServiceProvider<ModuleMessages> {
  const registrations = new Map(
    options.registrations.map((registration) => [
      registrationKey(registration.activation),
      registration,
    ]),
  );
  const active = new Set<string>();
  const routeGeneration = options.routeGeneration ?? 1;
  return {
    service: messagesService,
    bind(context) {
      const ownKey = registrationKey(context.activation);
      const registration = registrations.get(ownKey);
      if (!registration || !sameIdentity(registration.activation, context.activation)) {
        throw new Error("The fake message activation is not registered");
      }
      active.add(ownKey);
      context.own(() => { active.delete(ownKey); });

      const activeRegistrations = () => [...active]
        .map((id) => registrations.get(id))
        .filter((candidate): candidate is FakeMessageRegistration => candidate !== undefined);
      const traces: FakeRequestTrace<FakeRequest>[] = [];
      const request = createFakeRequestOperation<
        FakeRequest,
        unknown,
        MessageServiceErrorCode
      >({
        context,
        policy: POLICY,
        trace: traces,
        cancelledError: CANCELLED,
        disposedError: DISPOSED,
        failedError: failed,
        async handle(requestTrace) {
          const all = activeRegistrations();
          const request = requestTrace.input;
          if (request.kind === "send") {
            const envelope = wireEnvelope(
              request.input.channel.id,
              request.input.channel.message,
              request.input.payload,
              requestTrace.correlationId,
            );
            const handler = unique(all.flatMap(({ messages }) =>
              (messages.handles ?? []).filter(({ channel }) =>
                channel.id === request.input.channel.id
                && key(channel.message) === key(request.input.channel.message))));
            authorize(registration, handler.requiredGrant);
            validateBound(all, envelope);
            options.trace?.push({
              operation: "send",
              activation: context.activation,
              correlationId: requestTrace.correlationId,
              envelope,
            });
            await (handler as DirectedMessageHandler<unknown>).handle(envelope.payload);
            return {
              schemaVersion: MESSAGE_CONTRACT_SCHEMA_VERSION,
              endpoint: envelope.endpoint,
              message: envelope.message,
              routeGeneration,
            } satisfies DeliveryReceipt;
          }
          if (request.kind === "publish") {
            const envelope = wireEnvelope(
              request.input.topic.id,
              request.input.topic.message,
              request.input.payload,
              requestTrace.correlationId,
            );
            const publisher = unique(all.flatMap(({ messages }) =>
              (messages.publishes ?? []).filter(({ topic }) =>
                topic.id === request.input.topic.id
                && key(topic.message) === key(request.input.topic.message))));
            authorize(registration, publisher.requiredGrant);
            validateBound(all, envelope);
            const subscriptions = all.flatMap(({ messages }) =>
              (messages.subscribes ?? []).filter(({ topic }) =>
                topic.id === request.input.topic.id
                && key(topic.message) === key(request.input.topic.message)));
            options.trace?.push({
              operation: "publish",
              activation: context.activation,
              correlationId: requestTrace.correlationId,
              envelope,
            });
            const settled = await Promise.allSettled(
              subscriptions.map((subscription: BroadcastMessageSubscription<unknown>) =>
                subscription.handle(envelope.payload)),
            );
            if (settled.some(({ status }) => status === "rejected")) {
              throw new FakeMessageError(MESSAGE_DIAGNOSTIC_CODES.handlerFailed);
            }
            return {
              schemaVersion: MESSAGE_CONTRACT_SCHEMA_VERSION,
              endpoint: envelope.endpoint,
              message: envelope.message,
              routeGeneration,
              subscriberCount: subscriptions.length,
            } satisfies PublishReceipt;
          }
          const envelope = wireEnvelope(
            request.input.port.id,
            request.input.port.request,
            request.input.payload,
            requestTrace.correlationId,
          );
          const handler = unique(all.flatMap(({ messages }) =>
            (messages.ports ?? []).filter(({ port }) =>
              port.id === request.input.port.id
              && key(port.request) === key(request.input.port.request)
              && key(port.response) === key(request.input.port.response))));
          authorize(registration, handler.requiredGrant);
          validateBound(all, envelope);
          options.trace?.push({
            operation: "request",
            activation: context.activation,
            correlationId: requestTrace.correlationId,
            envelope,
          });
          const response = await handler.handle(envelope.payload);
          validateBound(all, wireEnvelope(
            request.input.port.id,
            request.input.port.response,
            response,
            requestTrace.correlationId,
          ));
          return response;
        },
      });
      return Object.freeze<ModuleMessages>({
        sendMessage: Object.freeze({
          policy: request.policy,
          execute<Payload>(input: SendMessageInput<Payload>, requestOptions?: SemanticRequestOptions) {
            return request.execute(
              { kind: "send", input: input as SendMessageInput<unknown> },
              requestOptions,
            ).then(outcome<DeliveryReceipt>);
          },
        }),
        publishMessage: Object.freeze({
          policy: request.policy,
          execute<Payload>(
            input: PublishMessageInput<Payload>,
            requestOptions?: SemanticRequestOptions,
          ) {
            return request.execute(
              { kind: "publish", input: input as PublishMessageInput<unknown> },
              requestOptions,
            ).then(outcome<PublishReceipt>);
          },
        }),
        requestMessage: Object.freeze({
          policy: request.policy,
          execute<Request, Response>(
            input: RequestMessageInput<Request, Response>,
            requestOptions?: SemanticRequestOptions,
          ) {
            return request.execute({
              kind: "request",
              input: input as RequestMessageInput<unknown, unknown>,
            }, requestOptions).then(outcome<Response>);
          },
        }),
      });
    },
  };
}
