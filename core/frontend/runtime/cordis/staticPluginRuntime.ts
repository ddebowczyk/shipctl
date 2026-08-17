import {
  messagesService,
  type ModuleActivationContext,
  type ModuleActivationId,
  type ModuleActivationIdentity,
  type ModuleHostServices,
  type ModuleId,
  type PluginActivationInspection,
  type PluginContributionFamily,
  type PluginContributionInspection,
  type PluginEffectInspection,
  type PluginRuntimeInspection,
  type SemanticServiceAccess,
  type SemanticServiceProviderContext,
  type SemanticServiceReference,
  type ShipctlModule,
  type ShipctlPluginDefinition,
  type ShipctlPluginRole,
} from "@shipctl/module-api";
import {
  Context,
  type CordisContext,
  type CordisFiber,
  type CordisFiberHandle,
} from "./vendor/cordis.js";

import {
  createModuleActivationIdentity,
  SemanticServiceRegistry,
  type SemanticActivationController,
} from "../semanticServiceRuntime.ts";
import {
  createActivationHostServiceGate,
  type ActivationHostServiceGate,
} from "../activationHostServices.ts";

const SEMANTIC_REGISTRY_SERVICE = "shipctl.runtime.semantic-services";

function semanticServiceKey(reference: SemanticServiceReference<unknown>): string {
  return `shipctl.semantic.${reference.id}@${reference.version}`;
}

function hasPresentation(module: ShipctlModule): boolean {
  return (module.commands?.length ?? 0) > 0
    || (module.panels?.length ?? 0) > 0
    || (module.globalSurfaces?.length ?? 0) > 0
    || (module.globalNavigation?.length ?? 0) > 0
    || (module.sidebar?.length ?? 0) > 0
    || (module.projectNavigation?.length ?? 0) > 0
    || (module.projectLayout?.length ?? 0) > 0
    || (module.projectActions?.length ?? 0) > 0
    || module.projectFactsProvider !== undefined
    || (module.settings?.length ?? 0) > 0
    || (module.terminalPresentations?.length ?? 0) > 0;
}

function hasHeadlessBehavior(module: ShipctlModule): boolean {
  return module.activate !== undefined
    || module.beforeShutdown !== undefined
    || module.projectLifecycle !== undefined
    || module.projectImport !== undefined
    || module.skillsProvider !== undefined
    || module.messages !== undefined
    || (module.scheduledTasks?.length ?? 0) > 0;
}

export function inferShipctlPluginRole(module: ShipctlModule): ShipctlPluginRole {
  const presentation = hasPresentation(module);
  const headless = hasHeadlessBehavior(module);
  if (presentation && headless) return "compound";
  if (presentation) return "presentation";
  return "headless";
}

export function adaptShipctlModule(module: ShipctlModule): ShipctlPluginDefinition {
  return Object.freeze({ module, role: inferShipctlPluginRole(module) });
}

function contributionRecords(
  definition: ShipctlPluginDefinition,
  identity: ModuleActivationIdentity,
): PluginContributionInspection[] {
  const { module } = definition;
  const records: PluginContributionInspection[] = [];
  const add = (family: PluginContributionFamily, id: string) => records.push({
    ownerActivationId: identity.activationId,
    moduleId: module.id,
    family,
    id,
  });
  for (const value of module.commands ?? []) add("command", value.id);
  for (const value of module.panels ?? []) add("panel", value.id);
  for (const value of module.globalSurfaces ?? []) add("global-surface", value.id);
  for (const value of module.globalNavigation ?? []) add("global-navigation", value.id);
  for (const value of module.sidebar ?? []) add("sidebar", value.id);
  for (const value of module.projectNavigation ?? []) add("project-navigation", value.id);
  for (const value of module.projectLayout ?? []) add("project-layout", value.id);
  for (const value of module.projectActions ?? []) add("project-action", value.id);
  if (module.projectFactsProvider) add("project-facts", module.projectFactsProvider.id);
  if (module.projectImport) add("project-import", module.projectImport.id);
  for (const value of module.settings ?? []) add("settings", value.id);
  if (module.skillsProvider) add("skills-provider", module.skillsProvider.id);
  for (const value of module.scheduledTasks ?? []) add("scheduled-task", value.id);
  if (module.messages) add("message-graph", `${module.id}.messages`);
  for (const value of module.terminalPresentations ?? []) {
    add("terminal-presentation", value.driverId);
  }
  return records;
}

function scopedHostServices(services: ModuleHostServices): ModuleHostServices {
  return Object.freeze({ ...services });
}

interface ActivePlugin {
  readonly definition: ShipctlPluginDefinition;
  readonly context: ModuleActivationContext;
  readonly contributions: readonly PluginContributionInspection[];
  readonly effects: readonly PluginEffectInspection[];
  readonly services: readonly {
    readonly ownerActivationId: string;
    readonly moduleId: string;
    readonly id: string;
    readonly version: number;
  }[];
  readonly fiber: CordisFiber;
  readonly hostServices: ActivationHostServiceGate | null;
}

export interface PluginActivationFailure {
  readonly moduleId: string;
  /** A redacted, stable reason that is safe to persist in runtime diagnostics. */
  readonly message: string;
}

export interface ObservedStaticPluginActivation {
  readonly activeModuleIds: ReadonlySet<string>;
  readonly activationContextsByModule: ReadonlyMap<ModuleId, ModuleActivationContext>;
  readonly failures: readonly PluginActivationFailure[];
  inspect(): PluginRuntimeInspection;
  publishHostServices(): void;
  deactivate(): Promise<void>;
}

export interface CordisStaticPluginRuntimeOptions {
  readonly services: ModuleHostServices;
  readonly semanticServices?: SemanticServiceRegistry;
  readonly activationIdsByModule?: ReadonlyMap<string, string>;
  /** Gate host mutations until the supervisor publishes the complete graph. */
  readonly gateHostServices?: boolean;
}

/**
 * The only Shipctl adapter that imports Cordis. Its public surface contains
 * Shipctl values only; fibers and contexts stay private.
 */
export class CordisStaticPluginRuntime {
  readonly #root: CordisContext = new Context();
  readonly #services: ModuleHostServices;
  readonly #semanticServices: SemanticServiceRegistry;
  readonly #activationIdsByModule: ReadonlyMap<string, string>;
  readonly #gateHostServices: boolean;
  readonly #states = new Map<string, PluginActivationInspection>();
  readonly #active = new Map<string, ActivePlugin>();
  readonly #contributionOwners = new Map<string, string>();
  readonly #activationOrder: string[] = [];
  readonly #failureMessages = new Map<string, string>();
  #leaseSequence = 0;
  #disposed = false;

  constructor(options: CordisStaticPluginRuntimeOptions) {
    this.#services = options.services;
    this.#semanticServices = options.semanticServices ?? new SemanticServiceRegistry();
    this.#activationIdsByModule = options.activationIdsByModule ?? new Map();
    this.#gateHostServices = options.gateHostServices ?? false;
    this.#root.provide(SEMANTIC_REGISTRY_SERVICE, this.#semanticServices);
  }

  async activateAll(
    definitions: readonly ShipctlPluginDefinition[],
  ): Promise<ObservedStaticPluginActivation> {
    if (this.#disposed) throw new Error("The Shipctl plugin runtime is disposed");
    const failures: PluginActivationFailure[] = [];
    for (const definition of definitions) {
      const active = await this.activate(definition);
      if (!active) {
        failures.push({
          moduleId: definition.module.id,
          message: this.#failureMessages.get(definition.module.id) ?? "Plugin activation failed",
        });
      }
    }
    return {
      activeModuleIds: new Set(this.#active.keys()),
      activationContextsByModule: new Map(
        [...this.#active].map(([moduleId, active]) => [moduleId as ModuleId, active.context]),
      ),
      failures,
      inspect: () => this.inspect(),
      publishHostServices: () => {
        for (const moduleId of this.#activationOrder) {
          this.#active.get(moduleId)?.hostServices?.accept();
        }
      },
      deactivate: () => this.dispose(),
    };
  }

  inspect(): PluginRuntimeInspection {
    return {
      activations: [...this.#states.values()].map((value) => ({ ...value })),
      contributions: [...this.#active.values()].flatMap((value) => value.contributions),
      effects: [...this.#active.values()].flatMap((value) => value.effects),
      services: [...this.#active.values()].flatMap((value) => value.services),
    };
  }

  async deactivate(moduleId: string): Promise<void> {
    const active = this.#active.get(moduleId);
    active?.hostServices?.beginDisposal();
    try {
      await active?.fiber.dispose();
    } finally {
      active?.hostServices?.dispose();
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const moduleId of [...this.#activationOrder].reverse()) {
      await this.deactivate(moduleId);
    }
    await this.#root.fiber.dispose();
  }

  async activate(definition: ShipctlPluginDefinition): Promise<boolean> {
    if (this.#disposed) throw new Error("The Shipctl plugin runtime is disposed");
    const { module } = definition;
    if (this.#active.has(module.id)) {
      this.#failureMessages.set(module.id, "Plugin activation is already active");
      return false;
    }
    const configuredActivationId = this.#activationIdsByModule.get(module.id);
    const identity: ModuleActivationIdentity = configuredActivationId === undefined
      ? createModuleActivationIdentity(module.id, module.version)
      : {
          moduleId: module.id,
          activationId: configuredActivationId as ModuleActivationId,
        };
    const hostServices = this.#gateHostServices
      ? createActivationHostServiceGate(this.#services)
      : null;
    const candidateContributions = contributionRecords(definition, identity);
    const candidateContributionKeys = new Set<string>();
    for (const contribution of candidateContributions) {
      const key = `${contribution.family}:${contribution.id}`;
      if (candidateContributionKeys.has(key) || this.#contributionOwners.has(key)) {
        hostServices?.dispose();
        this.#failureMessages.set(
          module.id,
          `Duplicate plugin contribution: ${contribution.family}:${contribution.id}`,
        );
        this.#states.set(module.id, {
          moduleId: module.id,
          activationId: identity.activationId,
          role: definition.role,
          status: "failed",
        });
        return false;
      }
      candidateContributionKeys.add(key);
    }
    this.#states.set(module.id, {
      moduleId: module.id,
      activationId: identity.activationId,
      role: definition.role,
      status: "preparing",
    });

    let fiber: CordisFiberHandle | null = null;
    const candidate = { semanticActivation: null as SemanticActivationController | null };
    const cordisPlugin = {
      name: `shipctl:${module.id}`,
      apply: async (cordisContext: CordisContext) => {
      const semanticRegistry = cordisContext.get(SEMANTIC_REGISTRY_SERVICE) as SemanticServiceRegistry;
      const semanticActivation = semanticRegistry.activate(identity);
      candidate.semanticActivation = semanticActivation;
      const stagedEffects: PluginEffectInspection[] = [{
        ownerActivationId: identity.activationId,
        moduleId: module.id,
        kind: "activation",
        id: module.id,
      }];
      const stagedServiceKeys = new Set<string>();
      const stagedServiceInstances = new Map<string, unknown>();
      const recordEffect = (kind: PluginEffectInspection["kind"], id: string) => {
        const key = `${kind}:${id}`;
        if (stagedEffects.some((effect) => `${effect.kind}:${effect.id}` === key)) return;
        stagedEffects.push({
          ownerActivationId: identity.activationId,
          moduleId: module.id,
          kind,
          id,
        });
      };
      cordisContext.effect(
        () => () => semanticActivation.dispose(),
        `shipctl.activation(${identity.activationId})`,
      );

      const registeredBackgroundEffects = new Set<string>();
      const ownCleanup = (cleanup: () => void | Promise<void>) => {
        const leaseId = `lease-${++this.#leaseSequence}`;
        recordEffect("owned-lease", leaseId);
        return semanticActivation.context.own(cleanup);
      };
      const own = (
        cleanup: () => void | Promise<void>,
        backgroundEffectId?: string,
      ) => {
        if (backgroundEffectId === undefined) {
          if (definition.backgroundEffects !== undefined) {
            throw new Error("Artifact background effects must register with their declared stable ID");
          }
        } else {
          if (!definition.backgroundEffects?.includes(backgroundEffectId)) {
            throw new Error(`Undeclared background effect: ${backgroundEffectId}`);
          }
          if (registeredBackgroundEffects.has(backgroundEffectId)) {
            throw new Error(`Duplicate background effect: ${backgroundEffectId}`);
          }
          registeredBackgroundEffects.add(backgroundEffectId);
          recordEffect("background", backgroundEffectId);
        }
        return ownCleanup(cleanup);
      };
      const access: SemanticServiceAccess = {
        has: (reference) => stagedServiceInstances.has(semanticServiceKey(reference))
          || cordisContext.get(semanticServiceKey(reference)) !== undefined
          || semanticActivation.context.services.has(reference),
        require: <Service>(reference: SemanticServiceReference<Service>): Service => {
          const key = semanticServiceKey(reference);
          if (stagedServiceInstances.has(key)) {
            recordEffect("semantic-service", `${reference.id}@${reference.version}`);
            return stagedServiceInstances.get(key) as Service;
          }
          const published = cordisContext.get(key) as Service | undefined;
          if (published !== undefined) {
            recordEffect("semantic-service", `${reference.id}@${reference.version}`);
            return published;
          }
          const service = semanticActivation.context.services.require(reference);
          recordEffect("semantic-service", `${reference.id}@${reference.version}`);
          return service;
        },
      };
      const activation = Object.freeze({
        identity,
        services: Object.freeze(access),
        get disposed() { return semanticActivation.context.disposed; },
        own,
      }) satisfies ModuleActivationContext;

      const stagedServices: ActivePlugin["services"][number][] = [];
      for (const provider of definition.provides ?? []) {
        const key = semanticServiceKey(provider.service);
        if (stagedServiceInstances.has(key)
          || semanticActivation.context.services.has(provider.service)
          || cordisContext.get(key) !== undefined) {
          throw new Error(`Duplicate semantic service provider: ${provider.service.id}@${provider.service.version}`);
        }
        const providerContext: SemanticServiceProviderContext = {
          activation: identity,
          get active() { return !activation.disposed; },
          own,
        };
        const service = provider.bind(providerContext);
        stagedServiceKeys.add(key);
        stagedServiceInstances.set(key, service);
        stagedServices.push({
          ownerActivationId: identity.activationId,
          moduleId: module.id,
          id: provider.service.id,
          version: provider.service.version,
        });
        recordEffect("semantic-service", `${provider.service.id}@${provider.service.version}`);
      }

      for (const required of definition.requires ?? []) access.require(required);
      if (module.messages !== undefined) access.require(messagesService);

      const deactivation = module.activate?.({
        activation,
        panels: hostServices?.services.panels ?? this.#services.panels,
        services: scopedHostServices(hostServices?.services ?? this.#services),
      });
      if (deactivation) {
        ownCleanup(() => deactivation.deactivate());
      }

      for (const task of module.scheduledTasks ?? []) {
        if (task.moduleId !== module.id) {
          throw new Error(
            `Scheduled task ${task.id} belongs to ${task.moduleId}, not ${module.id}`,
          );
        }
        // The host commits declared schedules with the candidate message-route
        // graph. Registering a schedule here would make it an independent,
        // non-transactional side effect of plugin activation.
        recordEffect("scheduled-task", task.id);
      }

      if (definition.backgroundEffects !== undefined) {
        const missing = definition.backgroundEffects.filter(
          (id) => !registeredBackgroundEffects.has(id),
        );
        if (missing.length > 0) {
          throw new Error(`Missing declared background effects: ${missing.join(", ")}`);
        }
      }

      // Publication is the commit point. Activation work above may inspect a
      // staged service, but other plugins cannot observe it until all failure-
      // prone preparation succeeds.
      for (const [key, service] of stagedServiceInstances) {
        cordisContext.provide(key, service);
      }

      for (const contribution of candidateContributions) {
        recordEffect("contribution", `${contribution.family}:${contribution.id}`);
        this.#contributionOwners.set(
          `${contribution.family}:${contribution.id}`,
          identity.activationId,
        );
      }
      const active: ActivePlugin = {
        definition,
        context: activation,
        contributions: candidateContributions,
        effects: stagedEffects,
        services: stagedServices,
        fiber: fiber!,
        hostServices,
      };
      this.#active.set(module.id, active);
      this.#activationOrder.push(module.id);
      this.#states.set(module.id, {
        moduleId: module.id,
        activationId: identity.activationId,
        role: definition.role,
        status: "active",
      });
      return async () => {
        hostServices?.beginDisposal();
        this.#active.delete(module.id);
        for (const contribution of candidateContributions) {
          const key = `${contribution.family}:${contribution.id}`;
          if (this.#contributionOwners.get(key) === identity.activationId) {
            this.#contributionOwners.delete(key);
          }
        }
        const orderIndex = this.#activationOrder.lastIndexOf(module.id);
        if (orderIndex !== -1) this.#activationOrder.splice(orderIndex, 1);
        this.#states.set(module.id, {
          moduleId: module.id,
          activationId: identity.activationId,
          role: definition.role,
          status: "disposed",
        });
        stagedServiceKeys.clear();
        hostServices?.dispose();
      };
      },
    };

    try {
      fiber = this.#root.plugin(cordisPlugin);
      await fiber;
      this.#failureMessages.delete(module.id);
      return true;
    } catch (error) {
      hostServices?.beginDisposal();
      await fiber?.dispose();
      await candidate.semanticActivation?.dispose();
      hostServices?.dispose();
      this.#active.delete(module.id);
      this.#states.set(module.id, {
        moduleId: module.id,
        activationId: identity.activationId,
        role: definition.role,
        status: "failed",
      });
      this.#failureMessages.set(module.id, "Plugin activation failed");
      if (import.meta.env.DEV) console.error(`Plugin ${module.id} activation failed:`, error);
      return false;
    }
  }
}

export async function activateStaticPluginsObserved(
  services: ModuleHostServices,
  modules: readonly ShipctlModule[],
  activationIdsByModule: ReadonlyMap<string, string> = new Map(),
  semanticServices: SemanticServiceRegistry = new SemanticServiceRegistry(),
): Promise<ObservedStaticPluginActivation> {
  const runtime = new CordisStaticPluginRuntime({
    services,
    semanticServices,
    activationIdsByModule,
  });
  return runtime.activateAll(modules.map(adaptShipctlModule));
}

export async function activatePluginDefinitionsObserved(
  services: ModuleHostServices,
  definitions: readonly ShipctlPluginDefinition[],
  activationIdsByModule: ReadonlyMap<string, string> = new Map(),
  semanticServices: SemanticServiceRegistry = new SemanticServiceRegistry(),
  gateHostServices = false,
): Promise<ObservedStaticPluginActivation> {
  const runtime = new CordisStaticPluginRuntime({
    services,
    semanticServices,
    activationIdsByModule,
    gateHostServices,
  });
  return runtime.activateAll(definitions);
}
