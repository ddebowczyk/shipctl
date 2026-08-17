// The host runtime: module activation, composition of their contributions,
// and the services the host injects back into them.
//
// JSX-free by design; the React surface lives in ./views.ts.
export {
  PanelRegistrationError,
  PanelRegistry,
} from "./panelRegistry.ts";
export {
  GlobalSurfaceRegistrationError,
  GlobalSurfaceRegistry,
} from "./globalSurfaceRegistry.ts";
export {
  CanvasSurfaceCatalog,
  CanvasSurfaceCatalogError,
  CanvasSurfaceLoadError,
  createEnabledCanvasSurfaceCatalog,
} from "./canvasSurfaceCatalog.ts";
export type {
  CanvasGlobalNavigationSurface,
  CanvasGlobalSurface,
  CanvasPanelSurface,
  CanvasProjectLayoutSurface,
  CanvasProjectNavigationSurface,
  CanvasSidebarSurface,
  CanvasSurfaceCatalogInput,
  CanvasSurfaceLoadKind,
} from "./canvasSurfaceCatalog.ts";
export {
  WorkspaceContributionCatalog,
  WorkspaceContributionCatalogError,
} from "./workspaceContributionCatalog.ts";
export type {
  ActivatedWorkspaceContribution,
  WorkspaceContributionCatalogInput,
  WorkspaceContributionCatalogInspection,
  WorkspaceContributionFamily,
  WorkspaceContributionOwner,
  WorkspaceContributionRecord,
  WorkspaceContributionSource,
  WorkspaceRendererEntry,
} from "./workspaceContributionCatalog.ts";
export {
  activeWorkspaceContributionEntries,
  canvasSurfaceComponentKey,
  currentCanvasSurfaceActivation,
  currentModuleActivation,
} from "./acceptedWorkspaceContributionEntries.ts";
export {
  BUILTIN_GLOBAL_NAVIGATION,
  createBuiltinGlobalSurfaceContributions,
} from "./builtinGlobalSurfaceAdapters.ts";
export type {
  BuiltinGlobalSurfaceKind,
  BuiltinGlobalSurfaceLoaders,
} from "./builtinGlobalSurfaceAdapters.ts";
export {
  hydratePanelReference,
  PANEL_REFERENCE_SCHEMA_VERSION,
  panelIdForTab,
  toPersistedPanelReference,
} from "./panelPersistence.ts";
export { MODULE_HOST_SERVICES } from "./moduleHostServices.ts";
export {
  refreshProjectActions,
  resolveProjectActionGroups,
  subscribeProjectActions,
  useModuleProjectActions,
} from "./projectActions.ts";
export {
  refreshProjectFacts,
  resolveProjectFacts,
  subscribeProjectFacts,
  useProjectFacts,
  useProjectFactsMap,
} from "./projectFacts.ts";

export { ENABLED_MODULES } from "./enabledModules.ts";
export {
  buildFrontendRuntimeSnapshot,
  MODULE_CONTROL_SCHEMA_VERSION,
  publishFrontendRuntimeSnapshot,
} from "./moduleRuntimeSnapshot.ts";
export type {
  FrontendContributionSnapshot,
  FrontendModuleRuntimeSnapshot,
  FrontendRuntimeSnapshot,
  FrontendRuntimeSnapshotOptions,
  RuntimeModuleActivationPhase,
  RuntimeModuleActivationSnapshot,
  RuntimeSnapshotReceipt,
} from "./moduleRuntimeSnapshot.ts";
export {
  createEnabledGlobalSurfaceRegistry,
  createEnabledPanelRegistry,
  discoverRelatedProjectPaths,
  enabledProjectActionContributions,
  enabledProjectFactsProvider,
  enabledProjectLayoutContributions,
  moduleGlobalNavigationContributions,
  moduleGlobalSurfaceContributions,
  modulePanelMigrationAliases,
  modulePanelContributions,
  moduleProjectActionContributions,
  moduleProjectFactsProviders,
  moduleProjectLayoutContributions,
  moduleProjectImportContributions,
  moduleProjectNavigationContributions,
  moduleScheduledTasks,
  moduleSidebarContributions,
  moduleSkillsProvider,
  moduleSettingsContributions,
  notifyModulesFilesystemChanged,
  notifyModulesProjectOpened,
  notifyModulesBeforeShutdown,
  notifyModulesProjectRemoved,
  notifyModulesProjectsChanged,
  selectProjectFactsProvider,
} from "./moduleComposition.ts";
export {
  MessageBusBridge,
  createModuleMessageActivations,
  moduleMessageGrants,
  openModuleMessageBridge,
} from "./messageBusBridge.ts";
export { LiveModuleSupervisor } from "./liveModuleSupervisor.ts";
export type {
  LiveModuleFamily,
  LiveModuleSupervisorOptions,
} from "./liveModuleSupervisor.ts";
export { AcceptedWorkspaceCatalogController } from "./acceptedWorkspaceCatalogController.ts";
export type {
  AcceptedWorkspaceCatalogControllerOptions,
  WorkspaceCatalogSynchronizationFailure,
} from "./acceptedWorkspaceCatalogController.ts";
export type {
  HostMessageDispatchResult,
  ModuleMessageBridgeBindings,
  OpenModuleMessageBridge,
} from "./messageBusBridge.ts";
export {
  createActivationMessageClient,
  messageDeclarations,
  prepareModuleMessageActivation,
} from "./moduleMessageContext.ts";
export type {
  ModuleMessageActivation,
  ModuleMessageHandlers,
  PreparedModuleMessageActivation,
} from "./moduleMessageContext.ts";
export { bindTerminalSessionDimensions } from "../terminal-host/terminalSessions.ts";
export {
  ModuleArtifactLoadError,
  assertDigestQualifiedArtifactUrl,
  loadShipctlModuleArtifact,
  moduleArtifactUrl,
} from "./moduleArtifactLoader.ts";
export type {
  LoadedShipctlModuleArtifact,
  LoadShipctlModuleArtifactRequest,
  ModuleArtifactLoadPhase,
} from "./moduleArtifactLoader.ts";
export {
  collectPluginArtifactDeclarations,
  parsePluginArtifactDeclarations,
  samePluginArtifactDeclarations,
} from "./pluginArtifactDeclarations.ts";
export {
  getRuntimeModuleLoadCatalog,
  loadRuntimeModules,
} from "./runtimeModuleLoader.ts";
export type {
  LoadedRuntimeModules,
  RuntimeModuleLoadOptions,
  RuntimeModuleLoadCatalog,
  RuntimeModuleLoadDescriptor,
  RuntimeModuleLoadFailure,
} from "./runtimeModuleLoader.ts";
export type {
  HydratedPanelReference,
  HydratePanelReferenceOptions,
  PanelMigrationAlias,
  PanelReferenceRecovery,
  PanelReferenceUnavailableReason,
  PersistedPanelReference,
} from "./panelPersistence.ts";
export type {
  ContributionId,
  GlobalNavigationContribution,
  GlobalSurfaceContribution,
  GlobalSurfaceContributionProps,
  ModuleId,
  ModuleDeactivation,
  ModuleHost,
  ModuleHostServices,
  ModuleScheduledTask,
  ModulePanelProps,
  PanelContribution,
  PanelHostPort,
  PanelIconDescriptor,
  PanelUnavailableMetadata,
  ProjectAction,
  ProjectActionContribution,
  ProjectActionGroup,
  ProjectActionSurfaceHost,
  ProjectActionSurfacePosition,
  ProjectActionSurfaceProps,
  ProjectCommandAction,
  ProjectFacts,
  ProjectFactsProviderContribution,
  ProjectLayoutContribution,
  ProjectLayoutContributionProps,
  ProjectLayoutSlot,
  ProjectNavigationContribution,
  ProjectNavigationContributionProps,
  ProjectRef,
  ProjectSurfaceAction,
  SidebarContribution,
  SidebarContributionProps,
  SettingsContribution,
  SettingsContributionProps,
  SettingsSlot,
  ShipctlModule,
  SkillsProviderContribution,
} from "@shipctl/module-api";
export { matchesPanelShortcut } from "./panelShortcuts.ts";
