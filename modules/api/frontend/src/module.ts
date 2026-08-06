import type { ModuleId, PanelContribution, PanelHostPort } from "./panels";

export interface ModuleDeactivation {
  deactivate(): void | Promise<void>;
}

export interface ModuleHost {
  readonly panels: PanelHostPort;
}

export interface ShepModule {
  readonly id: ModuleId;
  readonly version: string;
  readonly panels?: readonly PanelContribution[];
  activate?(host: ModuleHost): void | ModuleDeactivation;
}
