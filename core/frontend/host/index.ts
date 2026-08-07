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
  activateModules,
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
export { bindTerminalSessionDimensions } from "../terminal/terminalSessions.ts";
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
  ShepModule,
  SkillsProviderContribution,
} from "@shep/module-api";
export { matchesPanelShortcut } from "./panelShortcuts.ts";
