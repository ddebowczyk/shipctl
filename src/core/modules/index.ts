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
  toPersistedPanelReference,
} from "./panelPersistence";
export { default as PanelHost } from "./PanelHost";
export { ENABLED_MODULES } from "./enabledModules";
export {
  createEnabledPanelRegistry,
  modulePanelContributions,
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
  ModulePanelProps,
  PanelContribution,
  PanelHostPort,
  PanelIconDescriptor,
  PanelUnavailableMetadata,
  ProjectRef,
  ShepModule,
} from "@shep/module-api";
