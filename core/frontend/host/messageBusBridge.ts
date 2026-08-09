import {
  MESSAGE_CONTRACT_SCHEMA_VERSION,
  MESSAGE_DIAGNOSTIC_CODES,
  type MessageEnvelope,
  type ModuleMessages,
  type ShipctlModule,
} from "@shipctl/module-api";
import {
  RUNTIME_MESSAGE_TRANSPORT,
  type HostMessageFrame,
  type MessageBridgeFailure,
  type RuntimeMessageTransport,
} from "../platform/runtimeMessages.ts";
import {
  createModuleMessages,
  prepareModuleMessageActivation,
  type ModuleMessageActivation,
  type PreparedModuleMessageActivation,
} from "./moduleMessageContext.ts";

export interface HostMessageDispatchResult {
  readonly sequence: number;
  readonly accepted: boolean;
  readonly code?: string;
}

export interface OpenModuleMessageBridge {
  readonly bridge: MessageBusBridge;
  readonly messagesByModule: ReadonlyMap<string, ModuleMessages>;
}

function failure(code: string, message: string): MessageBridgeFailure {
  return { code, message };
}

function responseEnvelope(
  frame: HostMessageFrame,
  message: MessageEnvelope["message"],
  payload: unknown,
): MessageEnvelope {
  return {
    schemaVersion: MESSAGE_CONTRACT_SCHEMA_VERSION,
    endpoint: frame.endpoint,
    message,
    payload,
    ...(frame.correlationId === undefined ? {} : { correlationId: frame.correlationId }),
  };
}

export function moduleMessageGrants(module: ShipctlModule): readonly string[] {
  const messages = module.messages;
  return [...new Set([
    ...(messages?.handles ?? []).map(({ requiredGrant }) => requiredGrant),
    ...(messages?.publishes ?? []).map(({ requiredGrant }) => requiredGrant),
    ...(messages?.ports ?? []).map(({ requiredGrant }) => requiredGrant),
    ...(messages?.subscribes ?? []).map(({ topic }) => `message.subscribe.${topic.id}`),
  ])];
}

export function createModuleMessageActivations(
  modules: readonly ShipctlModule[],
  activationId: (module: ShipctlModule) => string = (module) =>
    `${module.id}@${module.version}#${crypto.randomUUID()}`,
): readonly ModuleMessageActivation[] {
  return modules
    .filter((module) => module.messages !== undefined)
    .map((module) => ({
      module,
      activationId: activationId(module),
      grants: moduleMessageGrants(module),
    }));
}

export class MessageBusBridge {
  readonly #transport: RuntimeMessageTransport;
  #activations: readonly PreparedModuleMessageActivation[];
  #byActivation: ReadonlyMap<string, PreparedModuleMessageActivation>;
  #bridgeId: string | null = null;
  #minimumRouteGeneration = 0;
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #dispatchQueue: Promise<void> = Promise.resolve();

  constructor(
    activations: readonly ModuleMessageActivation[],
    transport: RuntimeMessageTransport = RUNTIME_MESSAGE_TRANSPORT,
  ) {
    this.#transport = transport;
    this.#activations = activations.map(prepareModuleMessageActivation);
    this.#byActivation = new Map(
      this.#activations.map((activation) => [activation.activationId, activation]),
    );
  }

  async open(): Promise<OpenModuleMessageBridge> {
    if (this.#bridgeId !== null || this.#closed) {
      throw new Error("Runtime message bridge can only be opened once");
    }
    const receipt = await this.#transport.open(
      this.#activations.map(({ registration }) => registration),
      (frame) => {
        this.#dispatchQueue = this.#dispatchQueue
          .then(async () => { await this.dispatch(frame); })
          .catch(() => undefined);
      },
    );
    this.#bridgeId = receipt.bridgeId;
    this.#minimumRouteGeneration = receipt.snapshot.routeGeneration;
    return {
      bridge: this,
      messagesByModule: this.#moduleMessages(receipt.bridgeId, this.#activations),
    };
  }

  async reconcile(
    activations: readonly ModuleMessageActivation[],
  ): Promise<ReadonlyMap<string, ModuleMessages>> {
    const bridgeId = this.#bridgeId;
    if (bridgeId === null || this.#closed) {
      throw new Error("Runtime message bridge is not open");
    }
    const prepared = activations.map(prepareModuleMessageActivation);
    await this.#dispatchQueue;
    const receipt = await this.#transport.reconcile(
      bridgeId,
      this.#minimumRouteGeneration,
      prepared.map(({ registration }) => registration),
    );
    this.#activations = prepared;
    this.#byActivation = new Map(
      prepared.map((activation) => [activation.activationId, activation]),
    );
    this.#minimumRouteGeneration = receipt.snapshot.routeGeneration;
    return this.#moduleMessages(bridgeId, prepared);
  }

  #moduleMessages(
    bridgeId: string,
    activations: readonly PreparedModuleMessageActivation[],
  ): ReadonlyMap<string, ModuleMessages> {
    return new Map(activations.map((activation) => [
      activation.moduleId,
      createModuleMessages(bridgeId, activation.activationId, this.#transport),
    ]));
  }

  async dispatch(frame: HostMessageFrame): Promise<HostMessageDispatchResult> {
    const bridgeId = this.#bridgeId;
    const activation = this.#byActivation.get(frame.activationId);
    if (
      this.#closed
      || bridgeId === null
      || frame.bridgeId !== bridgeId
      || frame.routeGeneration < this.#minimumRouteGeneration
      || activation === undefined
    ) {
      return this.#rejectFrame(
        frame,
        failure(
          MESSAGE_DIAGNOSTIC_CODES.routeGenerationChanged,
          "Message frame targets an inactive activation generation",
        ),
      );
    }

    try {
      if (frame.kind === "directed") {
        const handlers = activation.handlers.directed.get(frame.endpoint);
        if (!handlers?.length) return this.#handlerUnavailable(frame);
        for (const handler of handlers) await handler.handle(frame.payload);
      } else if (frame.kind === "broadcast") {
        const handlers = activation.handlers.broadcast.get(frame.endpoint);
        if (!handlers?.length) return this.#handlerUnavailable(frame);
        const results = await Promise.allSettled(
          handlers.map((handler) => Promise.resolve().then(() => handler.handle(frame.payload))),
        );
        if (results.some((result) => result.status === "rejected")) {
          return this.#rejectFrame(
            frame,
            failure(
              MESSAGE_DIAGNOSTIC_CODES.handlerFailed,
              "Module message handler failed",
            ),
          );
        }
      } else {
        const handler = activation.handlers.ports.get(frame.endpoint);
        if (!handler || frame.correlationId === undefined) {
          return this.#handlerUnavailable(frame);
        }
        const payload = await handler.handle(frame.payload);
        await this.#transport.reply(bridgeId, {
          correlationId: frame.correlationId,
          response: responseEnvelope(frame, handler.port.response, payload),
        });
      }
      return { sequence: frame.sequence, accepted: true };
    } catch {
      return this.#rejectFrame(
        frame,
        failure(
          MESSAGE_DIAGNOSTIC_CODES.handlerFailed,
          "Module message handler failed",
        ),
      );
    }
  }

  async #handlerUnavailable(frame: HostMessageFrame): Promise<HostMessageDispatchResult> {
    return this.#rejectFrame(
      frame,
      failure(
        MESSAGE_DIAGNOSTIC_CODES.handlerUnavailable,
        "Module message handler is unavailable",
      ),
    );
  }

  async #rejectFrame(
    frame: HostMessageFrame,
    error: MessageBridgeFailure,
  ): Promise<HostMessageDispatchResult> {
    if (
      frame.kind !== "portRequest"
      && this.#bridgeId
      && (
        error.code === MESSAGE_DIAGNOSTIC_CODES.handlerFailed
        || error.code === MESSAGE_DIAGNOSTIC_CODES.handlerUnavailable
      )
    ) {
      try {
        await this.#transport.reportFailure(
          this.#bridgeId,
          frame.activationId,
          frame.endpoint,
          error.code,
        );
      } catch {
        // Reporting never interrupts later ordered frames or disposal.
      }
    }
    if (frame.kind === "portRequest" && frame.correlationId !== undefined && this.#bridgeId) {
      try {
        await this.#transport.reply(this.#bridgeId, {
          correlationId: frame.correlationId,
          error,
        });
      } catch {
        // The native bridge may already be gone; rejection remains contained.
      }
    }
    return { sequence: frame.sequence, accepted: false, code: error.code };
  }

  async settled(): Promise<void> {
    await this.#dispatchQueue;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      await this.#dispatchQueue;
      const bridgeId = this.#bridgeId;
      this.#bridgeId = null;
      if (bridgeId !== null) await this.#transport.close(bridgeId);
    })();
    return this.#closePromise;
  }
}

export async function openModuleMessageBridge(
  modules: readonly ShipctlModule[],
  transport: RuntimeMessageTransport = RUNTIME_MESSAGE_TRANSPORT,
  activationId?: (module: ShipctlModule) => string,
): Promise<OpenModuleMessageBridge> {
  const bridge = new MessageBusBridge(
    createModuleMessageActivations(modules, activationId),
    transport,
  );
  return bridge.open();
}
