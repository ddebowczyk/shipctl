import type { ModuleId, PanelContribution, PanelHostPort } from "./panels";
import type { ModuleHostServices } from "./services";
import type {
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
  readonly projectNavigation?: readonly ProjectNavigationContribution[];
  readonly settings?: readonly SettingsContribution[];
  readonly projectLifecycle?: ModuleProjectLifecycle;
  activate?(host: ModuleHost): void | ModuleDeactivation;
}
