import type { ModuleId, PanelContribution, PanelHostPort } from "./panels";
import type { ModuleHostServices } from "./services";
import type {
  GlobalNavigationContribution,
  GlobalSurfaceContribution,
  ModuleProjectLifecycle,
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

export interface ShepModule {
  readonly id: ModuleId;
  readonly version: string;
  readonly panels?: readonly PanelContribution[];
  readonly globalSurfaces?: readonly GlobalSurfaceContribution[];
  readonly globalNavigation?: readonly GlobalNavigationContribution[];
  readonly projectNavigation?: readonly ProjectNavigationContribution[];
  readonly settings?: readonly SettingsContribution[];
  readonly projectLifecycle?: ModuleProjectLifecycle;
  activate?(host: ModuleHost): void | ModuleDeactivation;
}
