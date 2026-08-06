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
  readonly projectActions?: readonly ProjectActionContribution[];
  readonly settings?: readonly SettingsContribution[];
  readonly skillsProvider?: SkillsProviderContribution;
  readonly projectLifecycle?: ModuleProjectLifecycle;
  activate?(host: ModuleHost): void | ModuleDeactivation;
}
