import type {
  ModuleActivationContext,
  ModuleId,
  SemanticServiceProvider,
  ShipctlModule,
  TerminalPresentationProvider,
  WorkspaceService,
} from "@shipctl/module-api";
import {
  CURRENT_CANVAS_WORKSPACE_ID,
  createDefaultWorkspaceCatalog,
  WorkspacePluginRuntime,
  WORKSPACE_PLUGIN_ADMISSION,
  WORKSPACE_PLUGIN_MODULE_ID,
} from "@shipctl/core/workspace";
import { createHostConfigurationServiceProvider } from "@shipctl/core/configuration";

import {
  activatePluginDefinitionsObserved,
  createApplicationRuntime,
  createModuleActivationIdentity,
  LiveModuleSupervisor,
  SemanticServiceRegistry,
  type ApplicationWorkspaceRuntime,
  type LiveModuleFamily,
  type ObservedStaticPluginActivation,
} from "../runtime/index.ts";
import {
  ACTIVATION_TERMINAL_SESSIONS,
  terminalHostAdapter,
} from "../terminal-host/index.ts";
import { createProjectsServiceProvider } from "../projects/index.ts";
import {
  createAssistantLaunchServiceProvider,
  createCredentialStoreServiceProvider,
  createGitServiceProvider,
  createMessagesServiceProvider,
  createPluginDataServiceProvider,
  createProcessesServiceProvider,
  createProjectDocumentsServiceProvider,
  createSchedulerServiceProvider,
  createSemanticTerminalsServiceProvider,
  createSkillInstallationServiceProvider,
  createTerminalSessionsServiceProvider,
  createUsageSourcesServiceProvider,
  getRuntimeModuleCatalog,
  observeModuleRegistryRevisions,
  reportModuleReconciliationFailure,
} from "../platform/index.ts";
import {
  BUILTIN_GLOBAL_NAVIGATION,
  createActivatedDirectMessageActivations,
  createAdmittedDirectMessageActivations,
  createBuiltinGlobalSurfaceContributions,
  createModuleMessageActivations,
  loadRuntimeModules,
  MODULE_HOST_SERVICES,
  openModuleMessageBridge,
  publishFrontendRuntimeSnapshot,
  WorkspaceContributionCatalog,
  type ModuleMessageActivation,
  type ModuleMessageBridgeBindings,
  type WorkspaceContributionSource,
} from "../host/index.ts";
import { BUILTIN_GLOBAL_SURFACE_LOADERS } from "./builtinGlobalSurfaceLoaders.ts";

export interface DesktopRuntimeFamily {
  readonly activeModules: readonly ShipctlModule[];
  readonly moduleActivations: ReadonlyMap<ModuleId, ModuleActivationContext>;
  /** Runs the accepted runtime family's pre-shutdown lifecycle. */
  beforeShutdown(): Promise<void>;
  /** Active terminal renderers are direct registrations, not static modules. */
  readonly terminalPresentations: readonly TerminalPresentationProvider[];
  readonly workspaceContributions: WorkspaceContributionCatalog;
}

type DesktopLiveModuleFamily = LiveModuleFamily<WorkspaceContributionCatalog>;
type DesktopLiveModuleFamilyInput = Pick<
  DesktopLiveModuleFamily,
  | "registryRevision"
  | "modules"
  | "activationContextsByModule"
  | "registeredContributionsByModule"
>;

interface BundledWorkspaceRuntime {
  readonly application: ApplicationWorkspaceRuntime;
  serviceProvider(): SemanticServiceProvider<WorkspaceService>;
}

function withCoreActivation(
  coreActivation: ModuleActivationContext,
  activations: ReadonlyMap<ModuleId, ModuleActivationContext>,
): ReadonlyMap<ModuleId, ModuleActivationContext> {
  return new Map([["core", coreActivation], ...activations]);
}

/**
 * Static artifacts remain in `family.modules` until their own conversions.
 * Direct artifacts contribute the same host-visible families from the accepted
 * activation snapshot, without being reconstructed as `ShipctlModule`s.
 */
function directWorkspaceContributionSources(
  family: DesktopLiveModuleFamilyInput,
): readonly WorkspaceContributionSource[] {
  const legacyModuleIds = new Set(family.modules.map(({ id }) => id));
  const sources: WorkspaceContributionSource[] = [];
  for (const [moduleId, contributions] of family.registeredContributionsByModule) {
    if (legacyModuleIds.has(moduleId)) continue;
    const activation = family.activationContextsByModule.get(moduleId);
    if (activation === undefined) {
      throw new Error(`Direct plugin ${moduleId} has no active context.`);
    }
    sources.push({
      moduleId,
      activation,
      commands: contributions.commands,
      panels: contributions.panels,
      globalSurfaces: contributions.globalSurfaces,
      globalNavigation: contributions.globalNavigation,
      sidebar: contributions.sidebars,
      projectNavigation: contributions.projectNavigation,
      projectLayout: contributions.projectLayouts,
      projectActions: contributions.projectActions,
      settings: contributions.settings,
    });
  }
  return Object.freeze(sources);
}

function terminalPresentationProviders(
  family: DesktopLiveModuleFamilyInput,
): readonly TerminalPresentationProvider[] {
  const legacyModuleIds = new Set(family.modules.map(({ id }) => id));
  const providers: TerminalPresentationProvider[] = [];
  for (const module of family.modules) {
    for (const provider of module.terminalPresentations ?? []) {
      if (provider.moduleId !== module.id) {
        throw new Error(
          `Terminal presentation ${provider.driverId} belongs to ${provider.moduleId}, not ${module.id}.`,
        );
      }
      providers.push(provider);
    }
  }
  for (const [moduleId, contributions] of family.registeredContributionsByModule) {
    if (legacyModuleIds.has(moduleId)) continue;
    for (const provider of contributions.terminalPresentations) {
      if (provider.moduleId !== moduleId) {
        throw new Error(
          `Terminal presentation ${provider.driverId} belongs to ${provider.moduleId}, not ${moduleId}.`,
        );
      }
      providers.push(provider);
    }
  }
  return Object.freeze(providers);
}

/**
 * Build the host's private renderer catalog from an already activated runtime
 * family. React loaders stay behind the desktop composition boundary.
 */
function createWorkspaceContributions(
  coreActivation: ModuleActivationContext,
  family: DesktopLiveModuleFamilyInput,
): WorkspaceContributionCatalog {
  return WorkspaceContributionCatalog.create({
    registryRevision: family.registryRevision,
    modules: family.modules,
    activationContextsByModule: family.activationContextsByModule,
    runtimeContributions: directWorkspaceContributionSources(family),
    hostContributions: [{
      moduleId: "core",
      activation: coreActivation,
      globalSurfaces: createBuiltinGlobalSurfaceContributions(BUILTIN_GLOBAL_SURFACE_LOADERS),
      globalNavigation: BUILTIN_GLOBAL_NAVIGATION,
    }],
  }).withHostWorkspaceDefinitions(createDefaultWorkspaceCatalog().definitions);
}

/**
 * The shell owns only the trusted direct-plugin activation envelope. All
 * workspace behavior remains inside `WorkspacePluginRuntime`.
 */
function createBundledWorkspaceRuntime(
  workspaceId: string,
  catalog: ReturnType<WorkspaceContributionCatalog["workspaceCatalog"]>,
): BundledWorkspaceRuntime {
  const runtime = new WorkspacePluginRuntime({ workspaceId, catalog });
  let activation: ObservedStaticPluginActivation | null = null;
  let starting: Promise<void> | null = null;

  const start = (): Promise<void> => {
    if (activation !== null) return Promise.resolve();
    if (starting !== null) return starting;
    const pending = (async () => {
      const observed = await activatePluginDefinitionsObserved(
        undefined,
        [runtime.definition],
        new Map(),
        new SemanticServiceRegistry([createPluginDataServiceProvider()]),
        false,
        new Map([[WORKSPACE_PLUGIN_MODULE_ID, WORKSPACE_PLUGIN_ADMISSION]]),
      );
      if (observed.failures.length > 0 || !observed.activeModuleIds.has(WORKSPACE_PLUGIN_MODULE_ID)) {
        await observed.deactivate();
        throw new Error(observed.failures[0]?.message ?? "Workspace plugin did not activate.");
      }
      activation = observed;
    })();
    starting = pending;
    void pending.then(
      () => { if (starting === pending) starting = null; },
      () => { if (starting === pending) starting = null; },
    );
    return pending;
  };

  const application = Object.freeze({
    get persistence() { return runtime.persistence; },
    diagnostics: () => runtime.diagnostics(),
    snapshot: () => runtime.snapshot(),
    subscribeCanvas: (listener) => runtime.subscribeCanvas(listener),
    subscribeDiagnostic: (listener) => runtime.subscribeDiagnostic(listener),
    submitCatalog: (nextCatalog) => runtime.submitCatalog(nextCatalog),
    start,
    async dispose() {
      const current = activation;
      activation = null;
      await current?.deactivate();
      await runtime.dispose();
    },
  } satisfies ApplicationWorkspaceRuntime);
  return Object.freeze({
    application,
    serviceProvider: () => runtime.serviceProvider(),
  });
}

/**
 * The former AppShell composition, relocated into an explicit runtime client.
 * Importing this module is passive; provider construction starts only when a
 * desktop runtime is requested.
 */
export function createDesktopApplicationRuntime() {
  const semanticServiceProviders = [
    createHostConfigurationServiceProvider(),
    createGitServiceProvider(),
    createProcessesServiceProvider(),
    createProjectDocumentsServiceProvider(),
    createProjectsServiceProvider(),
    createSkillInstallationServiceProvider(),
    createCredentialStoreServiceProvider(),
    createAssistantLaunchServiceProvider(),
    createUsageSourcesServiceProvider(),
    createPluginDataServiceProvider(),
  ];
  const semanticServices = new SemanticServiceRegistry(semanticServiceProviders);
  const coreActivation = semanticServices.activate(
    createModuleActivationIdentity("core", "host"),
  ).context;
  const initialWorkspaceContributions = createWorkspaceContributions(coreActivation, {
    registryRevision: 0,
    modules: [],
    activationContextsByModule: new Map<ModuleId, ModuleActivationContext>(),
    registeredContributionsByModule: new Map(),
  });
  const initialFamily: DesktopRuntimeFamily = Object.freeze({
    activeModules: Object.freeze([]),
    moduleActivations: withCoreActivation(coreActivation, new Map()),
    beforeShutdown: async () => undefined,
    terminalPresentations: Object.freeze([]),
    workspaceContributions: initialWorkspaceContributions,
  });
  const workspace = createBundledWorkspaceRuntime(
    CURRENT_CANVAS_WORKSPACE_ID,
    initialWorkspaceContributions.workspaceCatalog(),
  );

  return createApplicationRuntime({
    workspace: workspace.application,
    initialFamily,
    workspaceCatalog: (family) => family.workspaceContributions.workspaceCatalog(),
    createSupervisor: ({ publish, reportReconciliationFailure }) => (
      new LiveModuleSupervisor<
        ModuleMessageBridgeBindings,
        ModuleMessageActivation,
        WorkspaceContributionCatalog
      >({
        services: MODULE_HOST_SERVICES,
        createSemanticServices: (bindings, deactivateActivation) => new SemanticServiceRegistry([
          ...semanticServiceProviders,
          workspace.serviceProvider(),
          createMessagesServiceProvider({
            clientsByActivation: bindings.clientsByActivation,
            deactivateActivation,
          }),
          createSchedulerServiceProvider({
            bindingsByActivation: bindings.schedulerBindingsByActivation,
          }),
          createTerminalSessionsServiceProvider({
            bindingsByActivation: bindings.terminalBindingsByActivation,
            runtime: ACTIVATION_TERMINAL_SESSIONS,
            terminalHost: terminalHostAdapter,
          }),
          createSemanticTerminalsServiceProvider({
            bindingsByActivation: bindings.terminalBindingsByActivation,
          }),
        ]),
        getCatalog: getRuntimeModuleCatalog,
        observeRevisions: observeModuleRegistryRevisions,
        openMessageBridge: () => openModuleMessageBridge([]),
        createMessageActivations: createModuleMessageActivations,
        createAdmittedMessageActivations: createAdmittedDirectMessageActivations,
        createActivatedMessageActivations: createActivatedDirectMessageActivations,
        loadModules: loadRuntimeModules,
        createWorkspaceContributions: (family) => createWorkspaceContributions(coreActivation, family),
        retainWorkspaceContributions: (contributions, registryRevision) => (
          contributions.withRegistryRevision(registryRevision)
        ),
        publish: (family) => {
          const workspaceContributions = family.workspaceContributions;
          if (workspaceContributions === undefined) {
            reportReconciliationFailure({
              code: "runtime.workspace-contributions-missing",
              desiredRevision: family.registryRevision,
              stage: "publish",
              message: "The accepted runtime family has no canvas contribution catalog.",
            });
            return;
          }
          publish(Object.freeze({
            activeModules: family.modules,
            moduleActivations: withCoreActivation(
              coreActivation,
              family.activationContextsByModule,
            ),
            beforeShutdown: family.beforeShutdown,
            terminalPresentations: terminalPresentationProviders(family),
            workspaceContributions,
          }));
        },
        reportApplied: async (family) => {
          await publishFrontendRuntimeSnapshot(
            {
              registryRevision: family.registryRevision,
              activationContextsByModule: family.activationContextsByModule,
              artifactDescriptorsByModule: family.artifactDescriptorsByModule,
              inspection: family.inspection,
              activationOutcomes: [...family.artifactDescriptorsByModule.keys()].map((moduleId) => ({
                moduleId,
                status: "active" as const,
                phase: "active" as const,
              })),
            },
            family.modules,
          );
        },
        reportRejected: async (diagnostic) => {
          reportReconciliationFailure(diagnostic);
          await reportModuleReconciliationFailure({
            schemaVersion: 1,
            registryRevision: diagnostic.desiredRevision,
            moduleId: diagnostic.moduleId,
            activationId: diagnostic.activationId,
            phase: diagnostic.stage,
            code: diagnostic.code,
            message: diagnostic.message,
          });
        },
      })
    ),
  });
}

export type DesktopApplicationRuntime = ReturnType<typeof createDesktopApplicationRuntime>;
