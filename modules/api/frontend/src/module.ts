import type {
  ContributionId,
  ModuleId,
  PanelContribution,
  PanelHostPort,
} from "./panels";
import type { ModuleHostServices, ModuleSkillsPort } from "./services";
import type { ModuleMessageContributions, ModuleMessages } from "./messages";
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

export interface ModuleHost {
  readonly panels: PanelHostPort;
  readonly services: ModuleHostServices;
  /** Present for activations whose artifact declares message contributions. */
  readonly messages?: ModuleMessages;
}

export interface SkillsProviderContribution {
  readonly id: ContributionId;
  readonly moduleId: ModuleId;
  readonly port: ModuleSkillsPort;
}

export type ModuleTaskSchedule =
  | { readonly kind: "startup" }
  | { readonly kind: "delay"; readonly delayMs: number }
  | { readonly kind: "interval"; readonly intervalMs: number };

export interface ModuleScheduledTask {
  readonly id: ContributionId;
  readonly moduleId: ModuleId;
  readonly schedule: ModuleTaskSchedule;
  run(services: ModuleHostServices): void | Promise<void>;
}

export interface ShipctlModule {
  readonly id: ModuleId;
  readonly version: string;
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
  /** Runs in module registration order before native process shutdown begins. */
  beforeShutdown?(services: ModuleHostServices): void | Promise<void>;
  activate?(host: ModuleHost): void | ModuleDeactivation;
}
