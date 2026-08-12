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
  RuntimeSnapshotReceipt,
  StartupModulePhase,
  StartupModuleRuntimeSnapshot,
} from "./moduleRuntimeSnapshot.ts";
export {
  activateModules,
  activateModulesWithMessages,
  activateModulesWithMessagesObserved,
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
export type {
  ModuleActivationFailure,
  ObservedModuleActivation,
} from "./moduleComposition.ts";
export {
  MessageBusBridge,
  createModuleMessageActivations,
  moduleMessageGrants,
  openModuleMessageBridge,
} from "./messageBusBridge.ts";
export type {
  HostMessageDispatchResult,
  OpenModuleMessageBridge,
} from "./messageBusBridge.ts";
export {
  createModuleMessages,
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
  getStartupModuleCatalog,
  loadRestartBoundModules,
} from "./restartBoundModules.ts";
export type {
  RestartBoundModuleFailure,
  RestartBoundModules,
  StartupModuleCatalog,
  StartupModuleDescriptor,
} from "./restartBoundModules.ts";
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
  ModuleTaskSchedule,
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
