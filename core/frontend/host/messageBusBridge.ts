import {
  MESSAGE_CONTRACT_SCHEMA_VERSION,
  MESSAGE_DIAGNOSTIC_CODES,
  SCHEDULER_REGISTER_GRANT,
  type AcceptedPluginAdmission,
  type DirectShipctlPluginDefinition,
  type MessageEnvelope,
  type MessageDeclarations,
  type ShipctlPluginDefinition,
  type ShipctlModule,
} from "@shipctl/module-api";
import type { RegisteredPluginContributions } from "@shipctl/core/runtime";
import {
  RUNTIME_MESSAGE_TRANSPORT,
  type HostMessageFrame,
  type MessageBridgeFailure,
  type RuntimeMessageTransport,
} from "../platform/runtimeMessages.ts";
import type { ActivationMessageClientBinding } from "../platform/messages.ts";
import type { SchedulerTransportBinding } from "../platform/scheduler.ts";
import type { TerminalSessionsTransportBinding } from "../platform/terminalSessions.ts";
import {
  createActivationMessageClient,
  messageDeclarations,
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
  readonly clientsByActivation: ReadonlyMap<string, ActivationMessageClientBinding>;
  readonly activationIdsByModule: ReadonlyMap<string, string>;
  readonly schedulerBindingsByActivation: ReadonlyMap<string, SchedulerTransportBinding>;
  readonly terminalBindingsByActivation: ReadonlyMap<string, TerminalSessionsTransportBinding>;
}

export type ModuleMessageBridgeBindings = Omit<OpenModuleMessageBridge, "bridge">;

const EMPTY_MESSAGE_DECLARATIONS: MessageDeclarations = Object.freeze({
  schemaVersion: MESSAGE_CONTRACT_SCHEMA_VERSION,
  provides: Object.freeze([]),
  handles: Object.freeze([]),
  publishes: Object.freeze([]),
  subscribes: Object.freeze([]),
  ports: Object.freeze([]),
});

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
    ...(module.requiredGrants ?? []),
    ...(messages?.handles ?? []).map(({ requiredGrant }) => requiredGrant),
    ...(messages?.publishes ?? []).map(({ requiredGrant }) => requiredGrant),
    ...(messages?.ports ?? []).map(({ requiredGrant }) => requiredGrant),
    ...(messages?.subscribes ?? []).map(({ topic }) => `message.subscribe.${topic.id}`),
    ...((module.scheduledTasks?.length ?? 0) > 0 ? [SCHEDULER_REGISTER_GRANT] : []),
  ])];
}

export function createModuleMessageActivations(
  modules: readonly ShipctlModule[],
  activationId: (module: ShipctlModule) => string = (module) =>
    `${module.id}@${module.version}#${crypto.randomUUID()}`,
): readonly ModuleMessageActivation[] {
  return modules
    .filter((module) => module.messages !== undefined
      || (module.scheduledTasks?.length ?? 0) > 0
      || (module.requiredGrants?.length ?? 0) > 0)
    .map((module) => ({
      moduleId: module.id,
      activationId: activationId(module),
      grants: moduleMessageGrants(module),
      declarations: messageDeclarations(module),
      ...(module.messages === undefined ? {} : { messages: module.messages }),
      ...(module.scheduledTasks === undefined ? {} : { scheduledTasks: module.scheduledTasks }),
    }));
}

function isDirectDefinition(
  definition: ShipctlPluginDefinition,
): definition is DirectShipctlPluginDefinition {
  return !("module" in definition);
}

function directActivation(
  definition: DirectShipctlPluginDefinition,
  admissionsByModule: ReadonlyMap<string, AcceptedPluginAdmission>,
  activationIdsByModule: ReadonlyMap<string, string>,
  contributions?: RegisteredPluginContributions,
): ModuleMessageActivation {
  const admission = admissionsByModule.get(definition.id);
  const activationId = activationIdsByModule.get(definition.id);
  if (admission === undefined || activationId === undefined) {
    throw new Error(`Direct plugin ${definition.id} has no accepted message admission.`);
  }
  if (contributions !== undefined && contributions.messages.length > 1) {
    throw new Error(`Direct plugin ${definition.id} registered multiple message graphs.`);
  }
  return {
    moduleId: definition.id,
    activationId,
    grants: admission.effectiveGrants,
    declarations: admission.messages ?? EMPTY_MESSAGE_DECLARATIONS,
    ...(contributions?.messages[0] === undefined ? {} : { messages: contributions.messages[0] }),
    ...(contributions === undefined || contributions.scheduledTasks.length === 0
      ? {}
      : { scheduledTasks: contributions.scheduledTasks }),
  };
}

/**
 * Direct artifacts get a private bridge client from their already-admitted
 * declarations. No executable handler is exposed until activation succeeds.
 */
export function createAdmittedDirectMessageActivations(
  definitions: readonly ShipctlPluginDefinition[],
  admissionsByModule: ReadonlyMap<string, AcceptedPluginAdmission>,
  activationIdsByModule: ReadonlyMap<string, string>,
): readonly ModuleMessageActivation[] {
  return definitions
    .filter(isDirectDefinition)
    .map((definition) => directActivation(definition, admissionsByModule, activationIdsByModule));
}

/**
 * Replaces private admission placeholders with the accepted activation's own
 * handlers and schedules. The declaration remains the immutable manifest
 * value, so executable code cannot widen a native route during publication.
 */
export function createActivatedDirectMessageActivations(
  definitions: readonly ShipctlPluginDefinition[],
  admissionsByModule: ReadonlyMap<string, AcceptedPluginAdmission>,
  activationIdsByModule: ReadonlyMap<string, string>,
  contributionsByModule: ReadonlyMap<string, RegisteredPluginContributions>,
): readonly ModuleMessageActivation[] {
  return definitions
    .filter(isDirectDefinition)
    .map((definition) => {
      const contributions = contributionsByModule.get(definition.id);
      if (contributions === undefined) {
        throw new Error(`Direct plugin ${definition.id} has no activated contribution snapshot.`);
      }
      return directActivation(
        definition,
        admissionsByModule,
        activationIdsByModule,
        contributions,
      );
    });
}

export class MessageBusBridge {
  readonly #transport: RuntimeMessageTransport;
  readonly #observeFrame?: (frame: HostMessageFrame) => void | Promise<void>;
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
    observeFrame?: (frame: HostMessageFrame) => void | Promise<void>,
  ) {
    this.#transport = transport;
    this.#observeFrame = observeFrame;
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
    return { bridge: this, ...this.#bindings(receipt.bridgeId, this.#activations) };
  }

  /**
   * Create activation-scoped adapters for a private candidate. Native routes
   * do not change until `reconcile` accepts the same activation set.
   */
  bindingsFor(
    activations: readonly ModuleMessageActivation[],
  ): ModuleMessageBridgeBindings {
    const bridgeId = this.#bridgeId;
    if (bridgeId === null || this.#closed) {
      throw new Error("Runtime message bridge is not open");
    }
    return this.#bindings(
      bridgeId,
      activations.map(prepareModuleMessageActivation),
    );
  }

  async reconcile(
    activations: readonly ModuleMessageActivation[],
  ): Promise<ReadonlyMap<string, ActivationMessageClientBinding>> {
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
    return this.#messageClients(bridgeId, prepared);
  }

  #bindings(
    bridgeId: string,
    activations: readonly PreparedModuleMessageActivation[],
  ): ModuleMessageBridgeBindings {
    return {
      clientsByActivation: this.#messageClients(bridgeId, activations),
      activationIdsByModule: new Map(
        activations.map(({ moduleId, activationId }) => [moduleId, activationId]),
      ),
      schedulerBindingsByActivation: new Map(
        activations.map(({ moduleId, activationId }) => [activationId, {
          moduleId,
          activationId,
          bridgeId,
        }]),
      ),
      terminalBindingsByActivation: new Map(
        activations.map(({ moduleId, activationId, grants }) => [activationId, {
          moduleId,
          activationId,
          grants,
        }]),
      ),
    };
  }

  #messageClients(
    bridgeId: string,
    activations: readonly PreparedModuleMessageActivation[],
  ): ReadonlyMap<string, ActivationMessageClientBinding> {
    return new Map(activations.map((activation) => [
      activation.activationId,
      {
        moduleId: activation.moduleId,
        activationId: activation.activationId,
        client: createActivationMessageClient(
          bridgeId,
          activation.activationId,
          this.#transport,
        ),
      },
    ]));
  }

  /** Stop frontend delivery to one disposed activation before native teardown. */
  deactivateActivation(activationId: string): void {
    const next = new Map(this.#byActivation);
    next.delete(activationId);
    this.#byActivation = next;
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
      try {
        await this.#observeFrame?.(frame);
      } catch {
        // Observation cannot change message delivery or backpressure.
      }
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
  observeFrame?: (frame: HostMessageFrame) => void | Promise<void>,
): Promise<OpenModuleMessageBridge> {
  const bridge = new MessageBusBridge(
    createModuleMessageActivations(modules, activationId),
    transport,
    observeFrame,
  );
  return bridge.open();
}
