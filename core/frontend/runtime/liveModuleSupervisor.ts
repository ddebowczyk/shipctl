import type {
  AcceptedPluginAdmission,
  ModuleActivationContext,
  ModuleHostServices,
  ModuleId,
  PluginRuntimeInspection,
  ShipctlModule,
  ShipctlPluginDefinition,
} from "@shipctl/module-api";

import {
  LivePluginReconciler,
  RuntimeReconciliationError,
  type AcceptedRuntime,
  type DesiredPluginSnapshot,
  type ReconciliationDiagnostic,
  type RuntimeCandidate,
} from "./liveReconciler.ts";
import { assertCompleteRuntimeFamily } from "./runtimeFamilyValidation.ts";
import { SemanticServiceRegistry } from "./semanticServiceRuntime.ts";
import { activatePluginDefinitionsObserved } from "./cordis/index.ts";
import {
  collectPluginArtifactDeclarations,
  samePluginArtifactDeclarations,
} from "./pluginArtifactDeclarations.ts";
import type { RegisteredPluginContributions } from "./pluginContributionRegistry.ts";
import type {
  ModuleRegistryRevisionEvent,
  RuntimeModuleCatalog,
  RuntimeModuleDescriptor,
} from "./moduleCatalog.ts";

/**
 * One immutable family accepted by the runtime reconciliation transaction.
 * The optional catalog is private presentation data supplied by the desktop
 * composition; the runtime itself never imports a renderer to build it.
 */
export interface LiveModuleFamily<WorkspaceContributions = undefined> {
  readonly registryRevision: number;
  /**
   * Transitional view for static artifacts. Direct artifacts are represented
   * solely by their activation-owned registrations below.
   */
  readonly modules: readonly ShipctlModule[];
  readonly activationContextsByModule: ReadonlyMap<ModuleId, ModuleActivationContext>;
  /** Immutable runtime registration snapshot for every accepted artifact. */
  readonly registeredContributionsByModule: ReadonlyMap<
    ModuleId,
    RegisteredPluginContributions
  >;
  readonly artifactDescriptorsByModule: ReadonlyMap<string, RuntimeModuleDescriptor>;
  readonly inspection: PluginRuntimeInspection;
  /** Invokes accepted direct and legacy pre-shutdown hooks in activation order. */
  beforeShutdown(): Promise<void>;
  readonly workspaceContributions?: WorkspaceContributions;
}

/** Artifact loader result supplied by a platform or headless bootstrap. */
export interface LoadedRuntimeModules {
  readonly catalog: RuntimeModuleCatalog;
  /** Temporary compatibility view for artifacts not yet on direct activation. */
  readonly modules: readonly ShipctlModule[];
  readonly definitions: readonly ShipctlPluginDefinition[];
  readonly admissionsByModule: ReadonlyMap<string, AcceptedPluginAdmission>;
  readonly failures: readonly {
    readonly moduleId: string;
    readonly phase: "descriptor" | "resolve" | "import" | "validate" | "activation";
    readonly code: string;
    readonly message: string;
  }[];
}

/**
 * The runtime owns sequencing around message routes. The concrete transport
 * and activation-scoped bindings remain injected platform ports.
 */
export interface RuntimeMessageBridge<Bindings, MessageActivation> {
  bindingsFor(activations: readonly MessageActivation[]): Bindings;
  reconcile(activations: readonly MessageActivation[]): Promise<unknown>;
  deactivateActivation(activationId: string): void;
  close(): Promise<void>;
}

export interface OpenRuntimeMessageBridge<Bindings, MessageActivation> {
  readonly bridge: RuntimeMessageBridge<Bindings, MessageActivation>;
}

type LiveModuleFamilyInput = Omit<LiveModuleFamily<unknown>, "workspaceContributions">;

export interface LiveModuleSupervisorOptions<
  Bindings = unknown,
  MessageActivation = unknown,
  WorkspaceContributions = undefined,
> {
  readonly services: ModuleHostServices;
  readonly createSemanticServices: (
    bindings: Bindings,
    deactivateActivation: (activationId: string) => void,
  ) => SemanticServiceRegistry;
  readonly publish: (family: LiveModuleFamily<WorkspaceContributions>) => void;
  readonly reportApplied: (family: LiveModuleFamily<WorkspaceContributions>) => void | Promise<void>;
  readonly reportRejected?: (diagnostic: ReconciliationDiagnostic) => void | Promise<void>;
  /** All native and artifact adapters are supplied by the composition root. */
  readonly getCatalog: () => Promise<RuntimeModuleCatalog>;
  readonly observeRevisions: (
    receive: (event: ModuleRegistryRevisionEvent) => void,
  ) => Promise<() => void>;
  readonly openMessageBridge: () => Promise<OpenRuntimeMessageBridge<Bindings, MessageActivation>>;
  readonly createMessageActivations: (
    modules: readonly ShipctlModule[],
    activationId: (module: ShipctlModule) => string,
  ) => readonly MessageActivation[];
  /**
   * Direct artifacts receive admitted, data-only message registrations before
   * activation so a required messages/scheduler service can bind privately.
   */
  readonly createAdmittedMessageActivations?: (
    definitions: readonly ShipctlPluginDefinition[],
    admissionsByModule: ReadonlyMap<string, AcceptedPluginAdmission>,
    activationIdsByModule: ReadonlyMap<string, string>,
  ) => readonly MessageActivation[];
  /**
   * After a complete direct activation, replace placeholders with its owned
   * handlers and scheduled-task registrations before native publication.
   */
  readonly createActivatedMessageActivations?: (
    definitions: readonly ShipctlPluginDefinition[],
    admissionsByModule: ReadonlyMap<string, AcceptedPluginAdmission>,
    activationIdsByModule: ReadonlyMap<string, string>,
    contributionsByModule: ReadonlyMap<string, RegisteredPluginContributions>,
  ) => readonly MessageActivation[];
  readonly loadModules: (catalog: RuntimeModuleCatalog) => Promise<LoadedRuntimeModules>;
  /**
   * Compiles accepted activation-owned presentation declarations while the
   * candidate is private. It cannot activate modules or mutate workspace
   * persistence; publication remains owned by this supervisor.
   */
  readonly createWorkspaceContributions?: (
    family: LiveModuleFamilyInput,
  ) => WorkspaceContributions;
  /** Preserve immutable presentation data when an accepted graph is retained. */
  readonly retainWorkspaceContributions?: (
    contributions: WorkspaceContributions,
    registryRevision: number,
  ) => WorkspaceContributions;
}

interface PreparedFamilyCandidate<WorkspaceContributions, MessageActivation>
  extends RuntimeCandidate<LiveModuleFamily<WorkspaceContributions>> {
  readonly messageActivations: readonly MessageActivation[];
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

function definitionModuleId(definition: ShipctlPluginDefinition): string {
  return "module" in definition ? definition.module.id : definition.id;
}

/**
 * Runtime-owned desired/applied supervisor for replaceable artifact graphs and
 * one immutable public family. Platform transports are supplied as ports.
 */
export class LiveModuleSupervisor<
  Bindings = unknown,
  MessageActivation = unknown,
  WorkspaceContributions = undefined,
> {
  readonly #options: LiveModuleSupervisorOptions<Bindings, MessageActivation, WorkspaceContributions>;
  readonly #catalogs = new Map<number, RuntimeModuleCatalog>();
  readonly #reconciler: LivePluginReconciler<LiveModuleFamily<WorkspaceContributions>>;
  #bridge: RuntimeMessageBridge<Bindings, MessageActivation> | null = null;
  #unobserve: (() => void) | null = null;
  #starting: Promise<void> | null = null;
  #disposing: Promise<void> | null = null;
  #reconcileQueue: Promise<unknown> = Promise.resolve();
  #disposed = false;

  constructor(options: LiveModuleSupervisorOptions<Bindings, MessageActivation, WorkspaceContributions>) {
    this.#options = options;
    this.#reconciler = new LivePluginReconciler({
      prepare: (desired) => this.#prepare(desired),
      publish: (candidate) => this.#publish(
        candidate as PreparedFamilyCandidate<WorkspaceContributions, MessageActivation>,
      ),
      publishRetained: (accepted, desired) => this.#publishRetained(accepted, desired),
    });
  }

  get accepted(): AcceptedRuntime<LiveModuleFamily<WorkspaceContributions>> | null {
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
    const opened = await this.#options.openMessageBridge();
    this.#bridge = opened.bridge;
    if (this.#disposed) return;
    this.#unobserve = await this.#options.observeRevisions((event) => {
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
    const catalog = await this.#options.getCatalog();
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
    result: Awaited<ReturnType<LivePluginReconciler<LiveModuleFamily<WorkspaceContributions>>["reconcile"]>>,
  ): Promise<void> {
    if (result.disposition === "applied" && result.accepted !== null) {
      await this.#options.reportApplied(result.accepted.publicFamily);
    } else if (result.disposition === "rejected" && result.diagnostic !== undefined) {
      await this.#options.reportRejected?.(result.diagnostic);
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
    await this.#options.reportRejected?.(diagnostic);
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
      await this.#bridge?.close();
      this.#bridge = null;
    })();
    this.#disposing = disposing;
    return disposing;
  }

  async #prepare(
    desired: DesiredPluginSnapshot,
  ): Promise<PreparedFamilyCandidate<WorkspaceContributions, MessageActivation>> {
    const catalog = this.#catalogs.get(desired.registryRevision);
    const bridge = this.#bridge;
    if (catalog === undefined || bridge === null) {
      throw new Error(`Runtime catalog ${desired.registryRevision} is unavailable`);
    }
    const loaded = await this.#options.loadModules(catalog);
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
    const legacyMessageActivations = this.#options.createMessageActivations(
      loaded.modules,
      (module) => activationIdsByModule.get(module.id)!,
    );
    const admittedMessageActivations = this.#options.createAdmittedMessageActivations?.(
      loaded.definitions,
      loaded.admissionsByModule,
      activationIdsByModule,
    ) ?? [];
    const bindings = bridge.bindingsFor([
      ...legacyMessageActivations,
      ...admittedMessageActivations,
    ]);
    const activation = await activatePluginDefinitionsObserved(
      this.#options.services,
      loaded.definitions,
      activationIdsByModule,
      this.#options.createSemanticServices(
        bindings,
        (currentActivationId) => bridge.deactivateActivation(currentActivationId),
      ),
      true,
      loaded.admissionsByModule,
    );
    const assertCompleteActivation = () => {
      if (activation.failures.length === 0
        && activation.activeModuleIds.size === catalog.modules.length) return;
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
    };
    let messageActivations: readonly MessageActivation[];
    try {
      // A failed activation has no trustworthy live contribution set. Report
      // that lifecycle failure before comparing declarations, otherwise an
      // empty rollback is misleadingly reported as a manifest mismatch.
      assertCompleteActivation();
      const activeContributions = activation.inspect().contributions;
      for (const definition of loaded.definitions) {
        const moduleId = definitionModuleId(definition);
        const admitted = loaded.admissionsByModule.get(moduleId)?.application;
        if (admitted === undefined) continue;
        const runtime = collectPluginArtifactDeclarations(
          definition,
          activeContributions.filter((contribution) => contribution.moduleId === moduleId),
        );
        if (!samePluginArtifactDeclarations(admitted, runtime)) {
          throw new RuntimeReconciliationError(
            "module.loader.invalid_artifact",
            `Runtime contribution registrations for ${moduleId} do not match its admitted manifest`,
            { moduleId, activationId: activationIdsByModule.get(moduleId) },
          );
        }
      }
      messageActivations = [
        ...legacyMessageActivations,
        ...(this.#options.createActivatedMessageActivations?.(
          loaded.definitions,
          loaded.admissionsByModule,
          activationIdsByModule,
          activation.contributionsByModule,
        ) ?? admittedMessageActivations),
      ];
    } catch (error) {
      await activation.deactivate().catch(() => undefined);
      throw error;
    }
    const dynamicModules = loaded.modules.filter(
      (module) => activation.activeModuleIds.has(module.id),
    );
    const familyInput: LiveModuleFamilyInput = Object.freeze({
      registryRevision: desired.registryRevision,
      modules: Object.freeze(dynamicModules),
      activationContextsByModule: activation.activationContextsByModule,
      registeredContributionsByModule: activation.contributionsByModule,
      artifactDescriptorsByModule: descriptorsByModule,
      inspection: activation.inspect(),
      beforeShutdown: activation.beforeShutdown,
    });
    let family: LiveModuleFamily<WorkspaceContributions>;
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
        assertCompleteActivation();
        assertCompleteRuntimeFamily({
          moduleIds: catalog.modules.map(({ moduleId }) => moduleId),
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

  async #publish(
    candidate: PreparedFamilyCandidate<WorkspaceContributions, MessageActivation>,
  ): Promise<AcceptedRuntime<LiveModuleFamily<WorkspaceContributions>>> {
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
    accepted: AcceptedRuntime<LiveModuleFamily<WorkspaceContributions>>,
    desired: DesiredPluginSnapshot,
  ): AcceptedRuntime<LiveModuleFamily<WorkspaceContributions>> {
    const contributions = accepted.publicFamily.workspaceContributions;
    const workspaceContributions = contributions === undefined
      ? undefined
      : (this.#options.retainWorkspaceContributions?.(contributions, desired.registryRevision)
        ?? contributions);
    const family: LiveModuleFamily<WorkspaceContributions> = Object.freeze({
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
  #notifyPublished(family: LiveModuleFamily<WorkspaceContributions>): void {
    try {
      this.#options.publish(family);
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error("A runtime family publication observer failed:", error);
      }
    }
  }
}
