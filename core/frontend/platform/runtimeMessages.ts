import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  DeliveryReceipt,
  MessageDeclarations,
  MessageEnvelope,
  MessageRouteSnapshot,
  PublishReceipt,
  RegisterScheduleInput,
} from "@shipctl/module-api";

export type HostMessageFrameKind = "directed" | "broadcast" | "portRequest";

export interface FrontendBridgeRegistration {
  readonly moduleId: string;
  readonly activationId: string;
  readonly grants: readonly {
    readonly id: string;
    readonly effective: boolean;
  }[];
  readonly declarations: MessageDeclarations;
  readonly scheduledTasks: readonly RegisterScheduleInput<unknown>[];
}

export interface HostMessageFrame {
  readonly schemaVersion: 1;
  readonly bridgeId: string;
  readonly sequence: number;
  readonly routeGeneration: number;
  readonly activationId: string;
  readonly kind: HostMessageFrameKind;
  readonly endpoint: string;
  readonly message: MessageEnvelope["message"];
  readonly payload: unknown;
  readonly correlationId?: string;
}

export interface MessageBridgeOpenReceipt {
  readonly schemaVersion: 1;
  readonly bridgeId: string;
  readonly snapshot: MessageRouteSnapshot;
}

export interface MessageBridgeFailure {
  readonly code: string;
  readonly message: string;
}

export interface MessageBridgeReply {
  readonly correlationId: string;
  readonly response?: MessageEnvelope;
  readonly error?: MessageBridgeFailure;
}

export interface RuntimeMessageTransport {
  open(
    registrations: readonly FrontendBridgeRegistration[],
    onFrame: (frame: HostMessageFrame) => void,
  ): Promise<MessageBridgeOpenReceipt>;
  reconcile(
    bridgeId: string,
    expectedRouteGeneration: number,
    registrations: readonly FrontendBridgeRegistration[],
  ): Promise<MessageBridgeOpenReceipt>;
  close(bridgeId: string): Promise<MessageRouteSnapshot>;
  send(
    bridgeId: string,
    activationId: string,
    envelope: MessageEnvelope,
  ): Promise<DeliveryReceipt>;
  publish(
    bridgeId: string,
    activationId: string,
    envelope: MessageEnvelope,
  ): Promise<PublishReceipt>;
  request(
    bridgeId: string,
    activationId: string,
    envelope: MessageEnvelope,
  ): Promise<MessageEnvelope>;
  reply(bridgeId: string, reply: MessageBridgeReply): Promise<void>;
  reportFailure(
    bridgeId: string,
    activationId: string,
    endpoint: string,
    code: string,
  ): Promise<void>;
}

type InvokeCommand = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface FrameChannel {
  onmessage: ((frame: HostMessageFrame) => void) | null;
}

export function createRuntimeMessageTransport(
  invokeCommand: InvokeCommand = invoke,
  createChannel: () => FrameChannel = () => new Channel<HostMessageFrame>(),
): RuntimeMessageTransport {
  return {
    open(registrations, onFrame) {
      const channel = createChannel();
      channel.onmessage = onFrame;
      return invokeCommand("open_runtime_message_bridge", {
        registrations,
        onFrame: channel,
      });
    },
    reconcile: (bridgeId, expectedRouteGeneration, registrations) => invokeCommand(
      "reconcile_runtime_message_bridge",
      { bridgeId, expectedRouteGeneration, registrations },
    ),
    close: (bridgeId) => invokeCommand("close_runtime_message_bridge", { bridgeId }),
    send: (bridgeId, activationId, envelope) => invokeCommand("send_runtime_message", {
      bridgeId,
      activationId,
      envelope,
    }),
    publish: (bridgeId, activationId, envelope) => invokeCommand("publish_runtime_message", {
      bridgeId,
      activationId,
      envelope,
    }),
    request: (bridgeId, activationId, envelope) => invokeCommand("request_runtime_message", {
      bridgeId,
      activationId,
      envelope,
    }),
    reply: (bridgeId, reply) => invokeCommand("reply_runtime_message", { bridgeId, reply }),
    reportFailure: (bridgeId, activationId, endpoint, code) => invokeCommand(
      "report_runtime_message_failure",
      { bridgeId, activationId, endpoint, code },
    ),
  };
}

export const RUNTIME_MESSAGE_TRANSPORT = createRuntimeMessageTransport();
