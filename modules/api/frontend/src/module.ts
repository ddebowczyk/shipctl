import type {
  ContributionId,
  ModuleId,
  PanelContribution,
  PanelHostPort,
} from "./panels";
import type { ModuleHostServices, ModuleSkillsPort } from "./services";
import type {
  GlobalNavigationContribution,
  GlobalSurfaceContribution,
  ModuleProjectLifecycle,
  ProjectActionContribution,
  ProjectFactsProviderContribution,
  ProjectLayoutContribution,
  ProjectImportContribution,
  ProjectNavigationContribution,
  SettingsContribution,
} from "./surfaces";

export interface ModuleDeactivation {
  deactivate(): void | Promise<void>;
}

export interface ModuleHost {
  readonly panels: PanelHostPort;
  readonly services: ModuleHostServices;
}

export interface SkillsProviderContribution {
  readonly id: ContributionId;
  readonly moduleId: ModuleId;
  readonly port: ModuleSkillsPort;
}

export interface ShepModule {
  readonly id: ModuleId;
  readonly version: string;
  readonly panels?: readonly PanelContribution[];
  readonly globalSurfaces?: readonly GlobalSurfaceContribution[];
  readonly globalNavigation?: readonly GlobalNavigationContribution[];
  readonly projectNavigation?: readonly ProjectNavigationContribution[];
  readonly projectLayout?: readonly ProjectLayoutContribution[];
  readonly projectActions?: readonly ProjectActionContribution[];
  readonly projectFactsProvider?: ProjectFactsProviderContribution;
  readonly projectImport?: ProjectImportContribution;
  readonly settings?: readonly SettingsContribution[];
  readonly skillsProvider?: SkillsProviderContribution;
  readonly projectLifecycle?: ModuleProjectLifecycle;
  /** Runs in module registration order before native process shutdown begins. */
  beforeShutdown?(services: ModuleHostServices): void | Promise<void>;
  activate?(host: ModuleHost): void | ModuleDeactivation;
}
