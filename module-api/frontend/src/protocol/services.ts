export interface ModuleSettingsSnapshot {
  readonly values: Readonly<Record<string, unknown>>;
  readonly isSaving: boolean;
  readonly error: string | null;
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

export interface ModuleNotice {
  readonly tone: "info" | "success" | "error";
  readonly title: string;
  readonly message?: string;
  readonly actions?: readonly ModuleNoticeAction[];
}

export interface ModuleNoticeAction {
  readonly label: string;
  readonly variant?: "primary" | "secondary";
  readonly onClick: () => void;
}

export interface ModuleNoticeOptions {
  readonly durationMs?: number;
}

/**
 * Activation-local feedback channel supplied by the trusted desktop host.
 * It is not a privileged semantic service: modules use it only to surface
 * bounded, user-facing results from their already-authorized work.
 */
export interface ModuleNoticeSink {
  push(notice: ModuleNotice, options?: ModuleNoticeOptions): void;
}

export interface ModuleTerminalSessionIcon {
  readonly src: string;
  readonly alt?: string;
  readonly className?: string;
}

export interface ModuleTerminalSessionBadge {
  readonly label: string;
  readonly title: string;
  readonly tone: "muted" | "attention" | "success";
}

export interface ModuleTerminalSessionPresentation {
  /** Opt this module-owned terminal into the host's generic sessions list. */
  readonly showInSessionList?: boolean;
  readonly icon?: ModuleTerminalSessionIcon;
  readonly badge?: ModuleTerminalSessionBadge;
}

declare const moduleTerminalIdBrand: unique symbol;
export type ModuleTerminalId = string & { readonly [moduleTerminalIdBrand]: true };

export type ModuleJsonValue =
  | null
  | boolean
  | number
  | string
  | ModuleJsonValue[]
  | { [key: string]: ModuleJsonValue };

export interface ModuleTerminalSessionLaunchRequest {
  readonly projectPath: string;
  readonly moduleSessionId: string;
  readonly ownerKey: string;
  readonly command: string;
  readonly arguments?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly label: string;
  /** Passed back to the owner unchanged. Core must not inspect this value. */
  readonly ownerMetadata?: ModuleJsonValue;
  readonly presentation?: ModuleTerminalSessionPresentation;
  readonly columns: number;
  readonly rows: number;
}

export interface ModuleTerminalAgentActivity {
  readonly revision: number;
  readonly state: "idle" | "working" | "blocked";
  readonly message: string | null;
  readonly updatedAtMs: number;
  readonly source: {
    readonly identifier: string;
    readonly version: string;
  };
  readonly attention: {
    readonly kind: "blocked" | "completed";
    readonly revision: number;
  } | null;
}

export interface ModuleTerminalSession {
  /** Opaque runtime identity. Native PTY and tab identities remain host-owned. */
  readonly id: string;
  readonly terminalId: ModuleTerminalId;
  readonly moduleId: string;
  readonly projectPath: string;
  readonly ownerKey: string;
  readonly label: string;
  /** Passed back to the owner unchanged. Core must not inspect this value. */
  readonly ownerMetadata?: ModuleJsonValue;
  readonly presentation?: ModuleTerminalSessionPresentation;
  /** Supplemental agent state reported to the host; process lifecycle is separate. */
  readonly agentActivity?: ModuleTerminalAgentActivity;
}

export interface ModuleTerminalSessionUpdate {
  readonly label?: string;
  readonly ownerMetadata?: ModuleJsonValue;
  readonly presentation?: ModuleTerminalSessionPresentation;
}

export interface ModuleTerminalColorTheme {
  readonly foreground: string;
  readonly background: string;
  readonly palette: readonly string[];
}

/** The host-owned browser facts a terminal presentation may read. */
export interface ModuleTerminalPresentationSnapshot {
  readonly font: {
    readonly family: string;
    readonly sizePx: number;
    readonly lineHeight: number;
  };
  readonly palette: {
    readonly foreground: string;
    readonly background: string;
    readonly cursor: string;
    readonly selection: string;
  };
  readonly keybindings: {
    readonly shiftEnterNewline: boolean;
    readonly optionDeleteWord: boolean;
    readonly cmdKClear: boolean;
  };
  /** Whether the browser presentation blinks its visible cursor. */
  readonly cursorBlink: boolean;
  readonly confirmUnsafePaste: boolean;
}

export interface ModuleManagedTerminalStartContext {
  readonly moduleSessionId: string;
  readonly columns: number;
  readonly rows: number;
  readonly environment: Readonly<Record<string, string>>;
  readonly colorTheme: ModuleTerminalColorTheme;
}

export interface ModuleManagedTerminalStartResult {
  /** Native terminal identity; interpreted only by the host terminal adapter. */
  readonly terminalId: ModuleTerminalId;
  readonly ownerMetadata?: ModuleJsonValue;
  readonly presentation?: ModuleTerminalSessionPresentation;
}

export interface ModuleManagedTerminalSessionLaunchRequest {
  readonly projectPath: string;
  readonly moduleSessionId: string;
  readonly ownerKey: string;
  readonly cwd: string;
  readonly label: string;
  readonly ownerMetadata?: ModuleJsonValue;
  readonly presentation?: ModuleTerminalSessionPresentation;
  readonly columns: number;
  readonly rows: number;
  readonly start: (
    context: ModuleManagedTerminalStartContext,
  ) => Promise<ModuleManagedTerminalStartResult>;
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
      readonly type: "launched" | "adopted" | "updated";
      readonly session: ModuleTerminalSession;
    }
  | {
      readonly type: "exited";
      readonly session: ModuleTerminalSession;
      readonly reason: ModuleTerminalSessionExitReason;
      readonly exitCode: number | null;
    }
  | {
      readonly type: "closed";
      readonly session: ModuleTerminalSession;
    }
  | {
      readonly type: "rename-requested";
      readonly session: ModuleTerminalSession;
      readonly label: string;
    }
  | {
      readonly type: "placement-requested";
      readonly session: ModuleTerminalSession;
      readonly projectPath: string;
    }
  | {
      readonly type: "stop-requested";
      readonly session: ModuleTerminalSession;
      readonly reason: "tab-close" | "project-removal";
    };

/**
 * An opt-in, detachable observation of a module-owned terminal. It carries
 * exact process bytes only; a terminal implementation owns any replay or
 * screen state.
 */
export type ModuleTerminalSessionObservationEvent =
  | {
      readonly type: "data";
      readonly data: readonly number[];
    }
  | {
      readonly type: "exit";
      readonly exitCode: number | null;
    }
  | {
      readonly type: "resync";
      readonly reason: string;
    };

export interface ModuleTerminalSessionObservation {
  dispose(): Promise<void>;
}

export interface ModuleAppearanceSnapshot {
  readonly themeId: string;
  readonly background: string;
}
