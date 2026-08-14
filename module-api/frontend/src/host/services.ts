import type {
  ModuleAppearanceSnapshot,
  ModuleManagedTerminalSessionLaunchRequest,
  ModuleNotice,
  ModuleNoticeOptions,
  ModuleSettingsSnapshot,
  ModuleSkillsSnapshot,
  ModuleTerminalDimensions,
  ModuleTerminalPresentationSnapshot,
  ModuleTerminalSession,
  ModuleTerminalSessionLaunchRequest,
  ModuleTerminalSessionLifecycleEvent,
  ModuleTerminalSessionObservation,
  ModuleTerminalSessionObservationEvent,
  ModuleTerminalSessionUpdate,
} from "../protocol/services";
import type { PanelHostPort } from "./panels";

export interface ModuleSettingsPort {
  getSnapshot(): ModuleSettingsSnapshot;
  subscribe(listener: () => void): () => void;
  update(values: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface ModuleSkillsPort {
  getSnapshot(): ModuleSkillsSnapshot;
  subscribe(listener: () => void): () => void;
  install(projectPath: string, name: string): Promise<void>;
}

export interface ModuleNoticesPort {
  push(notice: ModuleNotice, options?: ModuleNoticeOptions): void;
}

export interface ModuleExternalLinksPort {
  open(url: string): Promise<void>;
}

export interface ModuleProjectDataPort {
  read(projectPath: string, capabilityId: string): Promise<unknown>;
  replace(
    projectPath: string,
    capabilityId: string,
    value: unknown,
  ): Promise<void>;
}

export interface ModuleGlobalDataPort {
  read(capabilityId: string): Promise<unknown>;
  replace(capabilityId: string, value: unknown): Promise<void>;
}

/**
 * Browser support supplied by the terminal host, without a renderer or
 * terminal-state type. A presentation owns its DOM and protocol; the host
 * owns preferences, notices, links, and desktop notifications.
 */
export interface ModuleTerminalPresentationPort {
  getSnapshot(): ModuleTerminalPresentationSnapshot;
  subscribe(listener: () => void): () => void;
  errorCode(error: unknown): string | null;
  recordMetric(terminalId: string, metric: string, milliseconds: number): void;
  recordDiagnostic(
    terminalId: string,
    event: string,
    facts?: Readonly<Record<string, string | number | boolean | null>>,
  ): void;
  notifyBell(terminalId: string, message: string): void;
}

export interface ModuleTerminalSessionsPort {
  getDimensions(): ModuleTerminalDimensions;
  /** Current host-derived module sessions; contains no attachment/output state. */
  list(): readonly ModuleTerminalSession[];
  launch(request: ModuleTerminalSessionLaunchRequest): Promise<ModuleTerminalSession>;
  launchManaged(
    request: ModuleManagedTerminalSessionLaunchRequest,
  ): Promise<ModuleTerminalSession>;
  update(
    sessionId: string,
    patch: ModuleTerminalSessionUpdate,
  ): Promise<ModuleTerminalSession>;
  /** Observe output separately from launch; the returned attachment must be disposed. */
  observe(
    sessionId: string,
    listener: (event: ModuleTerminalSessionObservationEvent) => void,
  ): Promise<ModuleTerminalSessionObservation>;
  stop(sessionId: string): Promise<void>;
  focus(sessionId: string): Promise<void>;
  subscribe(
    listener: (
      event: ModuleTerminalSessionLifecycleEvent,
    ) => void | Promise<void>,
  ): () => void;
}

export interface ModuleAppearancePort {
  getSnapshot(): ModuleAppearanceSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface ModuleHostServices {
  readonly panels: PanelHostPort;
  readonly appearance: ModuleAppearancePort;
  readonly globalData: ModuleGlobalDataPort;
  readonly projectData: ModuleProjectDataPort;
  readonly terminalSessions: ModuleTerminalSessionsPort;
  readonly terminalPresentation?: ModuleTerminalPresentationPort;
  readonly settings: ModuleSettingsPort;
  readonly skills: ModuleSkillsPort;
  readonly notices: ModuleNoticesPort;
  readonly externalLinks: ModuleExternalLinksPort;
}
