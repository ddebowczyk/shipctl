import type {
  ContributionId,
  ModuleId,
} from "../protocol/panels";
import type { ModuleMessageContributions } from "../protocol/messages";
import type { RegisterScheduleInput } from "../protocol/schedules";
import type { ModuleHost } from "../host/module";
import type { ModuleHostServices, ModuleSkillsPort } from "../host/services";
import type { ModuleActivationContext } from "../protocol/semanticServices";
import type { CommandContribution } from "./commands";
import type { PanelContribution } from "./panels";
import type { TerminalPresentationProvider } from "./terminalHost";
import type {
  GlobalNavigationContribution,
  GlobalSurfaceContribution,
  ModuleProjectLifecycle,
  ProjectActionContribution,
  ProjectFactsProviderContribution,
  ProjectLayoutContribution,
  ProjectImportContribution,
  ProjectNavigationContribution,
  SidebarContribution,
  SettingsContribution,
} from "./surfaces";

export interface ModuleDeactivation {
  deactivate(): void | Promise<void>;
}

export interface SkillsProviderContribution {
  readonly id: ContributionId;
  readonly moduleId: ModuleId;
  readonly port: ModuleSkillsPort;
}

export interface ModuleScheduledTask {
  readonly id: ContributionId;
  readonly moduleId: ModuleId;
  readonly schedule: Omit<RegisterScheduleInput<unknown>, "scheduleId">;
}

export interface ShipctlModule {
  readonly id: ModuleId;
  readonly version: string;
  /** Host capabilities that this activation must receive before module code runs. */
  readonly requiredGrants?: readonly string[];
  /** Static frontend commands. Native menu placement stays host-owned. */
  readonly commands?: readonly CommandContribution[];
  readonly panels?: readonly PanelContribution[];
  readonly globalSurfaces?: readonly GlobalSurfaceContribution[];
  readonly globalNavigation?: readonly GlobalNavigationContribution[];
  readonly sidebar?: readonly SidebarContribution[];
  readonly projectNavigation?: readonly ProjectNavigationContribution[];
  readonly projectLayout?: readonly ProjectLayoutContribution[];
  readonly projectActions?: readonly ProjectActionContribution[];
  readonly projectFactsProvider?: ProjectFactsProviderContribution;
  readonly projectImport?: ProjectImportContribution;
  readonly settings?: readonly SettingsContribution[];
  readonly skillsProvider?: SkillsProviderContribution;
  readonly projectLifecycle?: ModuleProjectLifecycle;
  readonly scheduledTasks?: readonly ModuleScheduledTask[];
  readonly messages?: ModuleMessageContributions;
  /** Build-installed terminal presentations. One terminal selects one driver. */
  readonly terminalPresentations?: readonly TerminalPresentationProvider[];
  /** Runs in module registration order before native process shutdown begins. */
  beforeShutdown?(
    services: ModuleHostServices,
    activation: ModuleActivationContext,
  ): void | Promise<void>;
  activate?(host: ModuleHost): void | ModuleDeactivation;
}
