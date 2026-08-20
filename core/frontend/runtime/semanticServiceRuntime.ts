import type {
  AcceptedPluginAdmission,
  AnySemanticServiceProvider,
  ModuleActivationContext,
  ModuleActivationId,
  ModuleActivationIdentity,
  ModuleId,
  ModuleNoticeSink,
  SemanticCleanup,
  SemanticLeaseId,
  SemanticOwnedLease,
  SemanticServiceAccess,
  SemanticServiceProviderContext,
  SemanticServiceReference,
} from "@shipctl/module-api";

import {
  createPluginContributionCollector,
  type PluginContributionCollector,
} from "./pluginContributionRegistry.ts";

function serviceKey(reference: SemanticServiceReference<unknown>): string {
  return `${reference.id}@${reference.version}`;
}

function randomIdentity(prefix: string): string {
  return `${prefix}#${crypto.randomUUID()}`;
}

const NOOP_NOTICE_SINK: ModuleNoticeSink = Object.freeze({
  push: () => undefined,
});

export function createModuleActivationIdentity(
  moduleId: ModuleId,
  version: string,
  nonce: string = crypto.randomUUID(),
): ModuleActivationIdentity {
  if (nonce.length === 0) throw new Error("Module activation nonce cannot be empty");
  return {
    moduleId,
    activationId: `${moduleId}@${version}#${nonce}` as ModuleActivationId,
  };
}

export interface SemanticActivationController {
  readonly context: ModuleActivationContext;
  readonly contributions: PluginContributionCollector;
  dispose(): Promise<void>;
}

class OwnedLease implements SemanticOwnedLease {
  readonly id: SemanticLeaseId;
  readonly activation: ModuleActivationIdentity;
  #cleanup: SemanticCleanup | null;

  constructor(
    activation: ModuleActivationIdentity,
    cleanup: SemanticCleanup,
  ) {
    this.id = randomIdentity("lease") as SemanticLeaseId;
    this.activation = activation;
    this.#cleanup = cleanup;
  }

  get disposed(): boolean {
    return this.#cleanup === null;
  }

  async dispose(): Promise<void> {
    const cleanup = this.#cleanup;
    if (cleanup === null) return;
    this.#cleanup = null;
    await cleanup();
  }
}

class ActivationController implements SemanticActivationController {
  readonly #identity: ModuleActivationIdentity;
  readonly #providers: ReadonlyMap<string, AnySemanticServiceProvider>;
  readonly #instances = new Map<string, unknown>();
  readonly #leases: OwnedLease[] = [];
  #disposed = false;
  readonly contributions: PluginContributionCollector;
  readonly context: ModuleActivationContext;

  constructor(
    identity: ModuleActivationIdentity,
    providers: ReadonlyMap<string, AnySemanticServiceProvider>,
    acceptedAdmission: AcceptedPluginAdmission | null,
  ) {
    this.#identity = identity;
    this.#providers = providers;
    const access: SemanticServiceAccess = {
      has: (reference) => !this.#disposed && this.#providers.has(serviceKey(reference)),
      require: <Service>(reference: SemanticServiceReference<Service>): Service => {
        this.#assertActive();
        const key = serviceKey(reference);
        if (this.#instances.has(key)) return this.#instances.get(key) as Service;
        const provider = this.#providers.get(key);
        if (!provider) throw new Error(`Semantic service ${key} is unavailable`);
        const controller = this;
        const providerContext: SemanticServiceProviderContext = {
          activation: this.#identity,
          acceptedAdmission,
          get active() { return !controller.#disposed; },
          own: (cleanup) => this.#own(cleanup),
        };
        const instance = provider.bind(providerContext);
        this.#instances.set(key, instance);
        return instance as Service;
      },
    };
    const controller = this;
    this.contributions = createPluginContributionCollector(
      identity,
      (cleanup) => this.#own(cleanup),
    );
    this.context = Object.freeze({
      identity,
      services: Object.freeze(access),
      notices: NOOP_NOTICE_SINK,
      contributions: this.contributions.registries,
      get disposed() { return controller.#disposed; },
      own: (cleanup: SemanticCleanup) => this.#own(cleanup),
    });
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error(`Module activation ${this.#identity.activationId} is disposed`);
    }
  }

  #own(cleanup: SemanticCleanup): SemanticOwnedLease {
    this.#assertActive();
    const lease = new OwnedLease(this.#identity, cleanup);
    this.#leases.push(lease);
    return lease;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const failures: unknown[] = [];
    for (const lease of [...this.#leases].reverse()) {
      try {
        await lease.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    this.#instances.clear();
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Module activation ${this.#identity.activationId} disposal failed`,
      );
    }
  }
}

/**
 * Trusted registry for service providers. Each activation gets a new binding
 * and cannot reuse an earlier activation identity.
 */
export class SemanticServiceRegistry {
  readonly #providers: ReadonlyMap<string, AnySemanticServiceProvider>;
  readonly #seenActivationIds = new Set<ModuleActivationId>();

  constructor(providers: readonly AnySemanticServiceProvider[] = []) {
    const indexed = new Map<string, AnySemanticServiceProvider>();
    for (const provider of providers) {
      const key = serviceKey(provider.service);
      if (indexed.has(key)) throw new Error(`Duplicate semantic service provider: ${key}`);
      indexed.set(key, provider);
    }
    this.#providers = indexed;
  }

  activate(
    identity: ModuleActivationIdentity,
    acceptedAdmission: AcceptedPluginAdmission | null = null,
  ): SemanticActivationController {
    if (this.#seenActivationIds.has(identity.activationId)) {
      throw new Error(`Module activation identity cannot be reused: ${identity.activationId}`);
    }
    this.#seenActivationIds.add(identity.activationId);
    return new ActivationController(identity, this.#providers, acceptedAdmission);
  }
}
