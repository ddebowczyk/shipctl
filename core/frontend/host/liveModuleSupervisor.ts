import type {
  ModuleActivationContext,
  ModuleHostServices,
  ModuleId,
  PluginRuntimeInspection,
  ShipctlModule,
} from "@shipctl/module-api";
import {
  LivePluginReconciler,
  RuntimeReconciliationError,
  assertCompleteRuntimeFamily,
  type AcceptedRuntime,
  type DesiredPluginSnapshot,
  type ReconciliationDiagnostic,
  type RuntimeCandidate,
  SemanticServiceRegistry,
  activatePluginDefinitionsObserved,
  adaptShipctlModule,
} from "../runtime/index.ts";
import {
  getRuntimeModuleCatalog,
  observeModuleRegistryRevisions,
  reportModuleReconciliationFailure,
  type RuntimeModuleCatalog,
  type RuntimeModuleDescriptor,
  type ModuleRegistryRevisionEvent,
} from "../platform/moduleControl.ts";
import {
  createModuleMessageActivations,
  openModuleMessageBridge,
  type MessageBusBridge,
  type ModuleMessageBridgeBindings,
  type OpenModuleMessageBridge,
} from "./messageBusBridge.ts";
import type { ModuleMessageActivation } from "./moduleMessageContext.ts";
import { loadRuntimeModules, type LoadedRuntimeModules } from "./runtimeModuleLoader.ts";
import type { WorkspaceContributionCatalog } from "./workspaceContributionCatalog.ts";

export interface LiveModuleFamily {
  readonly registryRevision: number;
  readonly modules: readonly ShipctlModule[];
  readonly activationContextsByModule: ReadonlyMap<ModuleId, ModuleActivationContext>;
  readonly artifactDescriptorsByModule: ReadonlyMap<string, RuntimeModuleDescriptor>;
  readonly inspection: PluginRuntimeInspection;
  /**
   * A private, immutable host catalog compiled before this family becomes
   * public. It contains a data-only semantic workspace catalog plus renderer
   * loaders that never escape through the workspace service.
   */
  readonly workspaceContributions?: WorkspaceContributionCatalog;
}

type LiveModuleFamilyInput = Omit<LiveModuleFamily, "workspaceContributions">;

export interface LiveModuleSupervisorOptions {
  readonly staticModules: readonly ShipctlModule[];
  readonly services: ModuleHostServices;
  readonly createSemanticServices: (
    bindings: ModuleMessageBridgeBindings,
    deactivateActivation: (activationId: string) => void,
  ) => SemanticServiceRegistry;
  readonly publish: (family: LiveModuleFamily) => void;
  readonly reportApplied: (family: LiveModuleFamily) => void | Promise<void>;
  readonly reportRejected?: (diagnostic: ReconciliationDiagnostic) => void | Promise<void>;
  readonly getCatalog?: () => Promise<RuntimeModuleCatalog>;
  readonly observeRevisions?: typeof observeModuleRegistryRevisions;
  /**
   * Host-only platform adapters. Production composition leaves these unset and
   * uses the native message bridge and immutable artifact loader. Modules have
   * no access to either choice.
   */
  readonly openMessageBridge?: (
    modules: readonly ShipctlModule[],
  ) => Promise<OpenModuleMessageBridge>;
  readonly loadModules?: (
    catalog: RuntimeModuleCatalog,
  ) => Promise<LoadedRuntimeModules>;
  /**
   * Compiles accepted activation-owned UI declarations while the candidate is
   * still private. It must not activate modules or mutate durable workspace
   * state; publication remains owned by this supervisor.
   */
  readonly createWorkspaceContributions?: (
    family: LiveModuleFamilyInput,
  ) => WorkspaceContributionCatalog;
}

interface PreparedFamilyCandidate extends RuntimeCandidate<LiveModuleFamily> {
  readonly messageActivations: readonly ModuleMessageActivation[];
  publishHostServices(): void;
}

function desiredSnapshot(catalog: RuntimeModuleCatalog): DesiredPluginSnapshot {
  return {
    registryRevision: catalog.registryRevision,
    modules: catalog.modules.map((descriptor) => ({
      moduleId: descriptor.moduleId,
      version: descriptor.version,
      contentDigest: descriptor.contentDigest,
    })),
  };
}

function sameDesiredModules(
  left: DesiredPluginSnapshot,
  right: DesiredPluginSnapshot,
): boolean {
  if (left.modules.length !== right.modules.length) return false;
  const leftIdentities = left.modules
    .map(({ moduleId, version, contentDigest }) => `${moduleId}@${version}#${contentDigest}`)
    .sort();
  const rightIdentities = right.modules
    .map(({ moduleId, version, contentDigest }) => `${moduleId}@${version}#${contentDigest}`)
    .sort();
  return leftIdentities.every((identity, index) => identity === rightIdentities[index]);
}

function recoveryCatalog(catalog: RuntimeModuleCatalog): RuntimeModuleCatalog | null {
  const lastApplied = catalog.lastApplied;
  if (lastApplied === undefined) return null;
  return {
    schemaVersion: catalog.schemaVersion,
    registryRevision: lastApplied.registryRevision,
    modules: lastApplied.modules,
  };
}

function activationId(descriptor: RuntimeModuleDescriptor): string {
  return `${descriptor.moduleId}@${descriptor.version}#${descriptor.contentDigest}`;
}

function combineInspection(
  staticInspection: PluginRuntimeInspection,
  dynamicInspection: PluginRuntimeInspection,
): PluginRuntimeInspection {
  return Object.freeze({
    activations: Object.freeze([
      ...staticInspection.activations,
      ...dynamicInspection.activations,
    ]),
    contributions: Object.freeze([
      ...staticInspection.contributions,
      ...dynamicInspection.contributions,
    ]),
    effects: Object.freeze([
      ...staticInspection.effects,
      ...dynamicInspection.effects,
    ]),
    services: Object.freeze([
      ...staticInspection.services,
      ...dynamicInspection.services,
    ]),
  });
}

/**
 * Host-owned desired/applied supervisor. Static compatibility modules stay in
 * one long-lived Cordis graph. Runtime artifacts use replaceable candidate
 * graphs and one immutable public family.
 */
export class LiveModuleSupervisor {
  readonly #options: LiveModuleSupervisorOptions;
  readonly #catalogs = new Map<number, RuntimeModuleCatalog>();
  readonly #reconciler: LivePluginReconciler<LiveModuleFamily>;
  #bridge: MessageBusBridge | null = null;
  #staticModules: readonly ShipctlModule[] = [];
  #staticActivations: ReadonlyMap<ModuleId, ModuleActivationContext> = new Map();
  #staticInspection: PluginRuntimeInspection = {
    activations: [],
    contributions: [],
    effects: [],
    services: [],
  };
  #staticMessageActivations: readonly ModuleMessageActivation[] = [];
  #deactivateStatic: (() => Promise<void>) | null = null;
  #unobserve: (() => void) | null = null;
  #starting: Promise<void> | null = null;
  #disposing: Promise<void> | null = null;
  #reconcileQueue: Promise<unknown> = Promise.resolve();
  #disposed = false;

  constructor(options: LiveModuleSupervisorOptions) {
    this.#options = options;
    this.#reconciler = new LivePluginReconciler({
      prepare: (desired) => this.#prepare(desired),
      publish: (candidate) => this.#publish(candidate as PreparedFamilyCandidate),
      publishRetained: (accepted, desired) => this.#publishRetained(accepted, desired),
    });
  }

  get accepted(): AcceptedRuntime<LiveModuleFamily> | null {
    return this.#reconciler.accepted;
  }

  start(): Promise<void> {
    if (this.#starting !== null || this.#disposed) {
      throw new Error("Live module supervisor can only be started once");
    }
    const starting = this.#start();
    this.#starting = starting;
    return starting.catch(async (error) => {
      await this.dispose();
      throw error;
    });
  }

  async #start(): Promise<void> {
    const opened = await (this.#options.openMessageBridge ?? openModuleMessageBridge)(
      this.#options.staticModules,
    );
    this.#bridge = opened.bridge;
    if (this.#disposed) return;
    this.#staticMessageActivations = createModuleMessageActivations(
      this.#options.staticModules,
      (module) => opened.activationIdsByModule.get(module.id)
        ?? `${module.id}@${module.version}#static`,
    );
    const staticActivation = await activatePluginDefinitionsObserved(
      this.#options.services,
      this.#options.staticModules.map(adaptShipctlModule),
      opened.activationIdsByModule,
      this.#options.createSemanticServices(
        opened,
        (activationId) => opened.bridge.deactivateActivation(activationId),
      ),
    );
    this.#deactivateStatic = staticActivation.deactivate;
    if (this.#disposed) return;
    this.#staticModules = this.#options.staticModules.filter(
      (module) => staticActivation.activeModuleIds.has(module.id),
    );
    this.#staticActivations = staticActivation.activationContextsByModule;
    this.#staticInspection = staticActivation.inspect();

    const observe = this.#options.observeRevisions ?? observeModuleRegistryRevisions;
    this.#unobserve = await observe((event) => {
      void this.reconcileLatest().catch((error) => {
        void this.#reportObservationFailure(event, error).catch((reportError) => {
          if (import.meta.env.DEV) {
            console.error("A runtime revision observation could not be reported:", reportError);
          }
        });
      });
    });
    if (this.#disposed) return;
    await this.reconcileLatest();
  }

  reconcileLatest(): Promise<void> {
    const scheduled = this.#reconcileQueue.then(() => this.#reconcileLatest());
    this.#reconcileQueue = scheduled.catch(() => undefined);
    return scheduled;
  }

  async #reconcileLatest(): Promise<void> {
    if (this.#disposed) return;
    const catalog = await (this.#options.getCatalog ?? getRuntimeModuleCatalog)();
    const recovery = this.#reconciler.accepted === null ? recoveryCatalog(catalog) : null;
    if (recovery !== null) {
      const recoveredDesired = desiredSnapshot(recovery);
      const currentDesired = desiredSnapshot(catalog);
      if (recovery.registryRevision === catalog.registryRevision
        && !sameDesiredModules(recoveredDesired, currentDesired)) {
        throw new Error(
          `Runtime catalog ${catalog.registryRevision} disagrees with its last applied graph`,
        );
      }
      if (recovery.registryRevision < catalog.registryRevision
        || !sameDesiredModules(recoveredDesired, currentDesired)) {
        this.#catalogs.set(recovery.registryRevision, recovery);
        await this.#reportResult(await this.#reconciler.reconcile(recoveredDesired));
      }
    }
    this.#catalogs.set(catalog.registryRevision, catalog);
    await this.#reportResult(await this.#reconciler.reconcile(desiredSnapshot(catalog)));
    for (const revision of this.#catalogs.keys()) {
      if (revision <= catalog.registryRevision) this.#catalogs.delete(revision);
    }
  }

  async #reportResult(
    result: Awaited<ReturnType<LivePluginReconciler<LiveModuleFamily>["reconcile"]>>,
  ): Promise<void> {
    if (result.disposition === "applied" && result.accepted !== null) {
      await this.#options.reportApplied(result.accepted.publicFamily);
    } else if (result.disposition === "rejected" && result.diagnostic !== undefined) {
      if (this.#options.reportRejected !== undefined) {
        await this.#options.reportRejected(result.diagnostic);
      } else {
        await reportModuleReconciliationFailure({
          schemaVersion: 1,
          registryRevision: result.diagnostic.desiredRevision,
          moduleId: result.diagnostic.moduleId,
          activationId: result.diagnostic.activationId,
          phase: result.diagnostic.stage,
          code: result.diagnostic.code,
          message: result.diagnostic.message,
        });
      }
    }
  }

  async #reportObservationFailure(
    event: ModuleRegistryRevisionEvent,
    error: unknown,
  ): Promise<void> {
    if (this.#disposed) return;
    const owned = error instanceof RuntimeReconciliationError ? error : null;
    const diagnostic: ReconciliationDiagnostic = Object.freeze({
      code: owned?.code ?? "module.runtime.revision_observer_failed",
      desiredRevision: event.registryRevision,
      stage: "observe",
      message: error instanceof Error ? error.message : "Runtime revision observation failed",
      ...(owned?.moduleId === undefined ? {} : { moduleId: owned.moduleId }),
      ...(owned?.activationId === undefined ? {} : { activationId: owned.activationId }),
    });
    if (this.#options.reportRejected !== undefined) {
      await this.#options.reportRejected(diagnostic);
    } else {
      await reportModuleReconciliationFailure({
        schemaVersion: 1,
        registryRevision: diagnostic.desiredRevision,
        moduleId: diagnostic.moduleId,
        activationId: diagnostic.activationId,
        phase: diagnostic.stage,
        code: diagnostic.code,
        message: diagnostic.message,
      });
    }
  }

  dispose(): Promise<void> {
    if (this.#disposing !== null) return this.#disposing;
    this.#disposed = true;
    const disposing = (async () => {
      await this.#starting?.catch(() => undefined);
      this.#unobserve?.();
      this.#unobserve = null;
      await this.#reconcileQueue;
      await this.#reconciler.dispose();
      await this.#deactivateStatic?.();
      this.#deactivateStatic = null;
      await this.#bridge?.close();
      this.#bridge = null;
    })();
    this.#disposing = disposing;
    return disposing;
  }

  async #prepare(desired: DesiredPluginSnapshot): Promise<PreparedFamilyCandidate> {
    const catalog = this.#catalogs.get(desired.registryRevision);
    const bridge = this.#bridge;
    if (catalog === undefined || bridge === null) {
      throw new Error(`Runtime catalog ${desired.registryRevision} is unavailable`);
    }
    const loaded = await (this.#options.loadModules ?? loadRuntimeModules)(catalog);
    if (loaded.failures.length > 0) {
      const failure = loaded.failures[0];
      const failedDescriptor = catalog.modules.find(
        ({ moduleId }) => moduleId === failure.moduleId,
      );
      throw new RuntimeReconciliationError(
        failure.code,
        `${failure.message} (${loaded.failures.length} artifact failure(s))`,
        {
          moduleId: failure.moduleId,
          activationId: failedDescriptor === undefined ? undefined : activationId(failedDescriptor),
        },
      );
    }
    const descriptorsByModule = new Map(
      catalog.modules.map((descriptor) => [descriptor.moduleId, descriptor]),
    );
    const activationIdsByModule = new Map(
      catalog.modules.map((descriptor) => [descriptor.moduleId, activationId(descriptor)]),
    );
    const dynamicMessageActivations = createModuleMessageActivations(
      loaded.modules,
      (module) => activationIdsByModule.get(module.id)!,
    );
    const messageActivations = [
      ...this.#staticMessageActivations,
      ...dynamicMessageActivations,
    ];
    const bindings = bridge.bindingsFor(messageActivations);
    const activation = await activatePluginDefinitionsObserved(
      this.#options.services,
      loaded.definitions,
      activationIdsByModule,
      this.#options.createSemanticServices(
        bindings,
        (activationId) => bridge.deactivateActivation(activationId),
      ),
      true,
    );
    const dynamicModules = loaded.modules.filter(
      (module) => activation.activeModuleIds.has(module.id),
    );
    const familyInput: LiveModuleFamilyInput = Object.freeze({
      registryRevision: desired.registryRevision,
      modules: Object.freeze([...this.#staticModules, ...dynamicModules]),
      activationContextsByModule: new Map([
        ...this.#staticActivations,
        ...activation.activationContextsByModule,
      ]),
      artifactDescriptorsByModule: descriptorsByModule,
      inspection: combineInspection(this.#staticInspection, activation.inspect()),
    });
    let family: LiveModuleFamily;
    try {
      const workspaceContributions = this.#options.createWorkspaceContributions?.(familyInput);
      family = Object.freeze({
        ...familyInput,
        ...(workspaceContributions === undefined ? {} : { workspaceContributions }),
      });
    } catch (error) {
      await activation.deactivate().catch(() => undefined);
      throw error;
    }
    let disposed = false;
    return {
      desired,
      publicFamily: family,
      messageActivations,
      publishHostServices: activation.publishHostServices,
      validate: async () => {
        if (activation.failures.length > 0
          || dynamicModules.length !== catalog.modules.length) {
          const failedActivation = activation.failures[0];
          const failedModuleId = failedActivation?.moduleId;
          throw new RuntimeReconciliationError(
            "module.runtime.activation_failed",
            `Runtime catalog ${desired.registryRevision} did not activate as one complete graph: ${
              failedActivation?.message ?? "plugin activation failed"
            }`,
            {
              moduleId: failedModuleId,
              activationId: failedModuleId === undefined
                ? undefined
                : activationIdsByModule.get(failedModuleId),
            },
          );
        }
        assertCompleteRuntimeFamily({
          modules: family.modules,
          activationContextsByModule: family.activationContextsByModule,
          inspection: family.inspection,
          expectedActivationIdsByModule: activationIdsByModule,
        });
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await activation.deactivate();
      },
    };
  }

  async #publish(candidate: PreparedFamilyCandidate): Promise<AcceptedRuntime<LiveModuleFamily>> {
    const bridge = this.#bridge;
    if (bridge === null) throw new Error("Runtime message bridge is unavailable");
    await bridge.reconcile(candidate.messageActivations);
    // Do not add an await between the route switch and this assignment. Browser
    // observers can therefore see only the complete predecessor or successor.
    candidate.publishHostServices();
    this.#notifyPublished(candidate.publicFamily);
    return {
      desired: candidate.desired,
      publicFamily: candidate.publicFamily,
      dispose: candidate.dispose,
    };
  }

  #publishRetained(
    accepted: AcceptedRuntime<LiveModuleFamily>,
    desired: DesiredPluginSnapshot,
  ): AcceptedRuntime<LiveModuleFamily> {
    const workspaceContributions = accepted.publicFamily.workspaceContributions
      ?.withRegistryRevision(desired.registryRevision);
    const family: LiveModuleFamily = Object.freeze({
      ...accepted.publicFamily,
      registryRevision: desired.registryRevision,
      ...(workspaceContributions === undefined ? {} : { workspaceContributions }),
    });
    this.#notifyPublished(family);
    return { desired, publicFamily: family, dispose: accepted.dispose };
  }

  /**
   * Publication is a commit notification, not a veto point. The message route,
   * host-service gate, and immutable family are already accepted when this
   * callback runs. An observer failure must not roll that transaction back or
   * make the reconciler dispose the newly public activation.
   */
  #notifyPublished(family: LiveModuleFamily): void {
    try {
      this.#options.publish(family);
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error("A runtime family publication observer failed:", error);
      }
    }
  }
}
