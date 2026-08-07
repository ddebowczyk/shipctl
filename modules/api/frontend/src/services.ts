import type { PanelHostPort } from "./panels";

export interface ModuleSettingsSnapshot {
  readonly values: Readonly<Record<string, unknown>>;
  readonly isSaving: boolean;
  readonly error: string | null;
}

export interface ModuleSettingsPort {
  getSnapshot(): ModuleSettingsSnapshot;
  subscribe(listener: () => void): () => void;
  update(values: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface ModuleSkillRef {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly installed: boolean;
}

export interface ModuleSkillsSnapshot {
  readonly byProject: Readonly<Record<string, readonly ModuleSkillRef[]>>;
}

export interface ModuleSkillsPort {
  getSnapshot(): ModuleSkillsSnapshot;
  subscribe(listener: () => void): () => void;
  install(projectPath: string, name: string): Promise<void>;
}

export interface ModuleNotice {
  readonly tone: "info" | "success" | "error";
  readonly title: string;
  readonly message?: string;
}

export interface ModuleNoticesPort {
  push(notice: ModuleNotice): void;
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

export interface ModuleTerminalSessionLaunchRequest {
  readonly projectPath: string;
  readonly ownerKey: string;
  readonly command: string;
  readonly arguments?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly label: string;
  readonly columns: number;
  readonly rows: number;
}

export interface ModuleTerminalSession {
  /** Opaque runtime identity. Native PTY and tab identities remain host-owned. */
  readonly id: string;
  readonly projectPath: string;
  readonly ownerKey: string;
  readonly label: string;
}

export interface ModuleTerminalDimensions {
  readonly columns: number;
  readonly rows: number;
}

export type ModuleTerminalSessionExitReason =
  | "manual-stop"
  | "zero-exit"
  | "nonzero-exit";

export type ModuleTerminalSessionLifecycleEvent =
  | {
      readonly type: "started";
      readonly session: ModuleTerminalSession;
    }
  | {
      readonly type: "exited";
      readonly session: ModuleTerminalSession;
      readonly reason: ModuleTerminalSessionExitReason;
      readonly exitCode: number | null;
    };

export interface ModuleTerminalSessionsPort {
  getDimensions(): ModuleTerminalDimensions;
  launch(request: ModuleTerminalSessionLaunchRequest): Promise<ModuleTerminalSession>;
  stop(sessionId: string): Promise<void>;
  focus(sessionId: string): Promise<void>;
  subscribe(
    listener: (event: ModuleTerminalSessionLifecycleEvent) => void,
  ): () => void;
}

export interface ModuleHostServices {
  readonly panels: PanelHostPort;
  readonly appearance: ModuleAppearancePort;
  readonly projectData: ModuleProjectDataPort;
  readonly terminalSessions: ModuleTerminalSessionsPort;
  readonly settings: ModuleSettingsPort;
  readonly skills: ModuleSkillsPort;
  readonly notices: ModuleNoticesPort;
  readonly externalLinks: ModuleExternalLinksPort;
}

export interface ModuleAppearanceSnapshot {
  readonly themeId: string;
  readonly background: string;
}

export interface ModuleAppearancePort {
  getSnapshot(): ModuleAppearanceSnapshot;
  subscribe(listener: () => void): () => void;
}
