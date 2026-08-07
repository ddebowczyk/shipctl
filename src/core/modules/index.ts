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
  BUILTIN_PANEL_DEFINITIONS,
  CORE_TAB_EXCEPTIONS,
  CORE_SURFACE_EXCEPTIONS,
  createBuiltinPanelContributions,
} from "./builtinPanelAdapters";
export type {
  BuiltinPanelLoaders,
} from "./builtinPanelAdapters";
export {
  hydratePanelReference,
  BUILTIN_PANEL_IDS,
  PANEL_REFERENCE_SCHEMA_VERSION,
  panelIdForTab,
  panelIdForTabKind,
  toPersistedPanelReference,
} from "./panelPersistence";
export { default as PanelHost } from "./PanelHost";
export { default as GlobalSurfaceHost } from "./GlobalSurfaceHost";
export {
  ModuleProjectActionSurface,
  ModuleProjectLayoutSurfaces,
  ModuleProjectNavigationSurfaces,
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
  createEnabledGlobalSurfaceRegistry,
  createEnabledPanelRegistry,
  enabledProjectActionContributions,
  enabledProjectFactsProvider,
  enabledProjectLayoutContributions,
  moduleGlobalNavigationContributions,
  moduleGlobalSurfaceContributions,
  moduleLegacyPanelDefinitions,
  modulePanelContributions,
  moduleProjectActionContributions,
  moduleProjectFactsProviders,
  moduleProjectLayoutContributions,
  moduleProjectNavigationContributions,
  moduleSkillsProvider,
  moduleSettingsContributions,
  notifyModulesFilesystemChanged,
  notifyModulesProjectRemoved,
  notifyModulesProjectsChanged,
  selectProjectFactsProvider,
} from "./moduleComposition";
export { BUILTIN_GLOBAL_SURFACE_LOADERS } from "./builtinGlobalSurfaceRuntime";
export {
  BUILTIN_PANEL_LOADERS,
  BuiltinPanelRuntimeProvider,
} from "./builtinPanelRuntime";
export type { BuiltinPanelRuntimeValue } from "./builtinPanelRuntime";
export type {
  HydratedPanelReference,
  HydratePanelReferenceOptions,
  LegacyPanelDefinition,
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
  SettingsContribution,
  SettingsContributionProps,
  ShepModule,
  SkillsProviderContribution,
} from "@shep/module-api";
