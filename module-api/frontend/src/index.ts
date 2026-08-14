export type {
  ContributionId,
  ModuleId,
  PanelIconDescriptor,
  PanelUnavailableMetadata,
  ProjectRef,
} from "./protocol/panels";
export type {
  ModulePanelProps,
  PanelHostPort,
} from "./host/panels";
export type { PanelContribution } from "./module/panels";

export type { CommandInvocationContext } from "./host/commands";
export type { CommandContribution } from "./module/commands";

export type {
  ModuleAppearanceSnapshot,
  ModuleManagedTerminalSessionLaunchRequest,
  ModuleManagedTerminalStartContext,
  ModuleManagedTerminalStartResult,
  ModuleNotice,
  ModuleNoticeAction,
  ModuleNoticeOptions,
  ModuleSettingsSnapshot,
  ModuleSkillRef,
  ModuleSkillsSnapshot,
  ModuleTerminalColorTheme,
  ModuleTerminalDimensions,
  ModuleTerminalId,
  ModuleJsonValue,
  ModuleTerminalPresentationSnapshot,
  ModuleTerminalSession,
  ModuleTerminalSessionBadge,
  ModuleTerminalSessionExitReason,
  ModuleTerminalSessionIcon,
  ModuleTerminalSessionLaunchRequest,
  ModuleTerminalSessionLifecycleEvent,
  ModuleTerminalSessionObservation,
  ModuleTerminalSessionObservationEvent,
  ModuleTerminalSessionPresentation,
  ModuleTerminalSessionUpdate,
} from "./protocol/services";
export type {
  ModuleAppearancePort,
  ModuleExternalLinksPort,
  ModuleGlobalDataPort,
  ModuleHostServices,
  ModuleNoticesPort,
  ModuleProjectDataPort,
  ModuleSettingsPort,
  ModuleSkillsPort,
  ModuleTerminalPresentationPort,
  ModuleTerminalSessionsPort,
} from "./host/services";

export type {
  ProjectActionSurfacePosition,
  ProjectFacts,
  ProjectLayoutSlot,
  SettingsSlot,
} from "./protocol/surfaces";
export type {
  GlobalSurfaceContributionProps,
  ProjectActionSurfaceHost,
  ProjectActionSurfaceProps,
  ProjectLayoutContributionProps,
  ProjectNavigationContributionProps,
  SettingsContributionProps,
  SidebarContributionProps,
} from "./host/surfaces";
export type {
  GlobalNavigationContribution,
  GlobalSurfaceContribution,
  ModuleProjectLifecycle,
  ProjectAction,
  ProjectActionContribution,
  ProjectActionGroup,
  ProjectCommandAction,
  ProjectFactsProviderContribution,
  ProjectImportContribution,
  ProjectLayoutContribution,
  ProjectNavigationContribution,
  ProjectSurfaceAction,
  SidebarContribution,
  SettingsContribution,
} from "./module/surfaces";

export type { ModuleTaskSchedule } from "./protocol/module";
export type { ModuleHost } from "./host/module";
export type {
  ModuleDeactivation,
  ModuleScheduledTask,
  ShipctlModule,
  SkillsProviderContribution,
} from "./module/module";

export { terminalDriverId } from "./protocol/terminalHost.ts";
export type {
  RawTerminalAttachment,
  RawTerminalOccurrence,
  TerminalDriverId,
  TerminalHostDescriptor,
  TerminalHostLaunchRequest,
  TerminalHostLifecycle,
  TerminalHostLifecycleEvent,
} from "./protocol/terminalHost.ts";
export type {
  TerminalHostPort,
  TerminalPresentationProps,
} from "./host/terminalHost";
export type { TerminalPresentationProvider } from "./module/terminalHost";

export {
  JSON_SCHEMA_DRAFT_2020_12,
  MESSAGE_CONTRACT_SCHEMA_VERSION,
  MESSAGE_DIAGNOSTIC_CODES,
  MessageContractParseError,
  parseDeliveryReceipt,
  parseMessageDeclarations,
  parseMessageEnvelope,
  parseMessageObservation,
  parseMessageRouteSnapshot,
  parsePublishReceipt,
} from "./protocol/messages.ts";
export type {
  BroadcastMessagePublisher,
  BroadcastMessageSubscription,
  BroadcastRoute,
  BroadcastTopic,
  CapabilityPort,
  CapabilityPortHandler,
  DeliveryReceipt,
  DirectedChannel,
  DirectedMessageHandler,
  DirectedRoute,
  MessageDeclarations,
  MessageDiagnosticCode,
  MessageEnvelope,
  MessageObservation,
  MessageRef,
  MessageRouteSnapshot,
  MessageSchemaDescriptor,
  MessageTypeContract,
  MessageTypeId,
  ModuleMessageContributions,
  ModuleMessages,
  PublishReceipt,
  RouteEndpointRef,
  WireBroadcastTopicDeclaration,
  WireCapabilityPortDeclaration,
  WireDirectedChannelDeclaration,
} from "./protocol/messages";

export {
  SCHEDULE_DIAGNOSTIC_CODES,
  SCHEDULE_INSPECTION_SCHEMA_VERSION,
  SCHEDULE_SCHEMA_VERSION,
  ScheduleInspectionParseError,
  parseScheduleInspection,
} from "./protocol/schedules.ts";
export type {
  ScheduleDefinitionInspection,
  ScheduleDeliveryOutcome,
  ScheduleDeliverySummary,
  ScheduleDiagnostic,
  ScheduleDiagnosticCode,
  ScheduleDiagnosticSeverity,
  ScheduleInspection,
  ScheduleTarget,
  ScheduleTargetAvailability,
  ScheduleTargetKind,
} from "./protocol/schedules";

export {
  CAPABILITY_CONTRACT_SCHEMA_VERSION,
  CAPABILITY_DIAGNOSTIC_CODES,
  CapabilityContractParseError,
  parseCapabilityManifest,
} from "./protocol/capabilities.ts";
export type {
  CapabilityAgentAccess,
  CapabilityAgentWatchAccess,
  CapabilityConsumerBinding,
  CapabilityDefinition,
  CapabilityDiagnosticCode,
  CapabilityEventDefinition,
  CapabilityManifest,
  CapabilityPortDefinition,
  CapabilityPortKind,
  CapabilityProviderBinding,
  CapabilityProviderCardinality,
  CapabilityProviderSelection,
  CapabilityReference,
  CapabilityScope,
  CapabilityStreamDefinition,
  CapabilitySurfaceBinding,
  CapabilityTopicDefinition,
} from "./protocol/capabilities";
