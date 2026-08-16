import {
  MESSAGE_CONTRACT_SCHEMA_VERSION,
  type BroadcastMessageSubscription,
  type CapabilityPortHandler,
  type DirectedMessageHandler,
  type MessageDeclarations,
  type ShipctlModule,
} from "@shipctl/module-api";
import type {
  ActivationMessageClient,
} from "../platform/messages.ts";
import type {
  FrontendBridgeRegistration,
  RuntimeMessageTransport,
} from "../platform/runtimeMessages.ts";

export interface ModuleMessageActivation {
  readonly module: ShipctlModule;
  readonly activationId: string;
  readonly grants: readonly string[];
}

export interface ModuleMessageHandlers {
  readonly directed: ReadonlyMap<string, readonly DirectedMessageHandler<unknown>[]>;
  readonly broadcast: ReadonlyMap<string, readonly BroadcastMessageSubscription<unknown>[]>;
  readonly ports: ReadonlyMap<string, CapabilityPortHandler<unknown, unknown>>;
}

export interface PreparedModuleMessageActivation {
  readonly moduleId: string;
  readonly activationId: string;
  readonly grants: ReadonlySet<string>;
  readonly registration: FrontendBridgeRegistration;
  readonly handlers: ModuleMessageHandlers;
}

function grouped<T extends { readonly channel: { readonly id: string } }>(
  contributions: readonly T[],
): ReadonlyMap<string, readonly T[]> {
  const result = new Map<string, T[]>();
  for (const contribution of contributions) {
    const existing = result.get(contribution.channel.id) ?? [];
    existing.push(contribution);
    result.set(contribution.channel.id, existing);
  }
  return result;
}

function groupedTopics(
  contributions: readonly BroadcastMessageSubscription<unknown>[],
): ReadonlyMap<string, readonly BroadcastMessageSubscription<unknown>[]> {
  const result = new Map<string, BroadcastMessageSubscription<unknown>[]>();
  for (const contribution of contributions) {
    const existing = result.get(contribution.topic.id) ?? [];
    existing.push(contribution);
    result.set(contribution.topic.id, existing);
  }
  return result;
}

export function messageDeclarations(module: ShipctlModule): MessageDeclarations {
  const messages = module.messages;
  return {
    schemaVersion: MESSAGE_CONTRACT_SCHEMA_VERSION,
    provides: messages?.provides ?? [],
    handles: (messages?.handles ?? []).map((handler) => ({
      endpoint: { id: handler.channel.id, message: handler.channel.message },
      capacity: handler.capacity,
      requiredGrant: handler.requiredGrant,
      schedulerAllowed: handler.schedulerAllowed,
    })),
    publishes: (messages?.publishes ?? []).map((publisher) => ({
      endpoint: { id: publisher.topic.id, message: publisher.topic.message },
      capacity: publisher.capacity,
      requiredGrant: publisher.requiredGrant,
      schedulerAllowed: publisher.schedulerAllowed,
    })),
    subscribes: (messages?.subscribes ?? []).map((subscription) => ({
      id: subscription.topic.id,
      message: subscription.topic.message,
    })),
    ports: (messages?.ports ?? []).map((handler) => ({
      id: handler.port.id,
      request: handler.port.request,
      response: handler.port.response,
      capacity: handler.capacity,
      requiredGrant: handler.requiredGrant,
      schedulerAllowed: handler.schedulerAllowed,
    })),
  };
}

export function prepareModuleMessageActivation(
  activation: ModuleMessageActivation,
): PreparedModuleMessageActivation {
  const messages = activation.module.messages;
  return {
    moduleId: activation.module.id,
    activationId: activation.activationId,
    grants: new Set(activation.grants),
    registration: {
      moduleId: activation.module.id,
      activationId: activation.activationId,
      grants: activation.grants.map((id) => ({ id, effective: true })),
      declarations: messageDeclarations(activation.module),
    },
    handlers: {
      directed: grouped(messages?.handles ?? []),
      broadcast: groupedTopics(messages?.subscribes ?? []),
      ports: new Map((messages?.ports ?? []).map((handler) => [handler.port.id, handler])),
    },
  };
}

export function createActivationMessageClient(
  bridgeId: string,
  activationId: string,
  transport: RuntimeMessageTransport,
): ActivationMessageClient {
  return {
    send: (envelope) => transport.send(bridgeId, activationId, envelope),
    publish: (envelope) => transport.publish(bridgeId, activationId, envelope),
    request: (envelope) => transport.request(bridgeId, activationId, envelope),
  };
}
