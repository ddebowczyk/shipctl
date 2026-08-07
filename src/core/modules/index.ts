export {
  PanelRegistrationError,
  PanelRegistry,
} from "./panelRegistry";
export {
  GlobalSurfaceRegistrationError,
  GlobalSurfaceRegistry,
} from "./globalSurfaceRegistry";
export {
  BUILTIN_GLOBAL_NAVIGATION,
  BUILTIN_GLOBAL_SURFACE_IDS,
  createBuiltinGlobalSurfaceContributions,
} from "./builtinGlobalSurfaceAdapters";
export type {
  BuiltinGlobalSurfaceKind,
  BuiltinGlobalSurfaceLoaders,
} from "./builtinGlobalSurfaceAdapters";
export {
  hydratePanelReference,
  PANEL_REFERENCE_SCHEMA_VERSION,
  panelIdForTab,
  toPersistedPanelReference,
} from "./panelPersistence";
export { default as PanelHost } from "./PanelHost";
export { default as GlobalSurfaceHost } from "./GlobalSurfaceHost";
export {
  ModuleProjectActionSurface,
  ModuleProjectLayoutSurfaces,
  ModuleProjectNavigationSurfaces,
  ModuleSidebarSurfaces,
  ModuleSettingsSurfaces,
} from "./ModuleSurfaces";
export { MODULE_HOST_SERVICES } from "./moduleHostServices";
export {
  refreshProjectActions,
  resolveProjectActionGroups,
  subscribeProjectActions,
  useModuleProjectActions,
} from "./projectActions";
export {
  refreshProjectFacts,
  resolveProjectFacts,
  subscribeProjectFacts,
  useProjectFacts,
  useProjectFactsMap,
} from "./projectFacts";
export type { ProjectFactsByPath } from "./projectFacts";
export { ENABLED_MODULES } from "./enabledModules";
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
} from "./moduleComposition";
export { bindTerminalSessionDimensions } from "./terminalSessions";
export { BUILTIN_GLOBAL_SURFACE_LOADERS } from "./builtinGlobalSurfaceRuntime";
export type {
  HydratedPanelReference,
  HydratePanelReferenceOptions,
  PanelMigrationAlias,
  PanelReferenceRecovery,
  PanelReferenceUnavailableReason,
  PersistedPanelReference,
} from "./panelPersistence";
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
