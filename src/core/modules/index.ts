export {
  PanelRegistrationError,
  PanelRegistry,
} from "./panelRegistry";
export {
  BUILTIN_PANEL_DEFINITIONS,
  CORE_TAB_EXCEPTIONS,
  NON_TAB_PANEL_SURFACES,
  createBuiltinPanelContributions,
} from "./builtinPanelAdapters";
export type {
  BuiltinPanelLoaders,
} from "./builtinPanelAdapters";
export {
  hydratePanelReference,
  BUILTIN_PANEL_IDS,
  PANEL_REFERENCE_SCHEMA_VERSION,
  panelIdForTabKind,
  tabKindForPanelId,
  toPersistedPanelReference,
} from "./panelPersistence";
export { default as PanelHost } from "./PanelHost";
export {
  ModuleProjectNavigationSurfaces,
  ModuleSettingsSurfaces,
} from "./ModuleSurfaces";
export { MODULE_HOST_SERVICES } from "./moduleHostServices";
export { ENABLED_MODULES } from "./enabledModules";
export {
  createEnabledPanelRegistry,
  modulePanelContributions,
  moduleProjectNavigationContributions,
  moduleSettingsContributions,
  notifyModulesFilesystemChanged,
  notifyModulesProjectRemoved,
  notifyModulesProjectsChanged,
} from "./moduleComposition";
export {
  BUILTIN_PANEL_LOADERS,
  BuiltinPanelRuntimeProvider,
} from "./builtinPanelRuntime";
export type { BuiltinPanelRuntimeValue } from "./builtinPanelRuntime";
export type {
  HydratedPanelReference,
  HydratePanelReferenceOptions,
  PanelReferenceRecovery,
  PanelReferenceUnavailableReason,
  PersistedPanelReference,
} from "./panelPersistence";
export type {
  ContributionId,
  ModuleId,
  ModuleDeactivation,
  ModuleHost,
  ModuleHostServices,
  ModulePanelProps,
  PanelContribution,
  PanelHostPort,
  PanelIconDescriptor,
  PanelUnavailableMetadata,
  ProjectNavigationContribution,
  ProjectNavigationContributionProps,
  ProjectRef,
  SettingsContribution,
  SettingsContributionProps,
  ShepModule,
} from "@shep/module-api";
