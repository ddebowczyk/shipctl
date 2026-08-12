import type { ModuleTerminalSessionPresentation } from "@shipctl/module-api";
import type {
  TerminalId,
  TerminalLifecycle,
  TerminalRevision,
  TerminalViewId,
} from "@shipctl/core/terminal-host";

// ── Config types (match Rust structs) ────────────────────────────────

export interface RepoInfo {
  path: string;
  name: string;
  group: string | null;
}

export interface RepoGroup {
  id: string;
  name: string;
  order: number;
}

export interface CommandConfig {
  name: string;
  command: string;
  autostart: boolean;
  env: Record<string, string>;
  cwd: string | null;
}

export interface WorkspaceConfig {
  name: string;
  commands: CommandConfig[];
  /** Module-owned top-level values are preserved without entering host schema. */
  [capabilityId: string]: unknown;
}

export interface RegisteredRepo {
  path: string;
  workspace: WorkspaceConfig;
}

export type PreferredEditor = "vscode" | "zed" | "cursor" | "sublime_text";

export interface EditorSettings {
  preferredEditor: PreferredEditor | null;
}

export interface ProjectSettings {
  showAgentSessionsInSidebar: boolean;
  /** Capability-owned values are preserved without becoming host contracts. */
  [key: string]: unknown;
}

export interface KeybindingSettings {
  shiftEnterNewline: boolean;
  optionDeleteWord: boolean;
  cmdKClear: boolean;
}

export type CursorStyle = "block" | "underline" | "bar";

export interface TerminalSettings {
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  /** Host history budget in bytes. The host measures history in bytes, not rows. */
  scrollbackBytes: number;
  fontFamily: string;
  fontSize: number;
  urlAllowlist: string[];
  confirmUnsafePaste: boolean;
}

/**
 * Terminal settings plus the retention revision they were committed at.
 * A response carrying a revision lower than the one already held is stale.
 */
export interface TerminalSettingsCommit extends TerminalSettings {
  retentionRevision: number;
}

export interface SidebarSettings {
  fontSize: number;
  fontFamily: string;
  width: number;
}

export interface UiState {
  lastRepoPath: string | null;
  themeId: string | null;
  customTheme: unknown | null;
}

export interface FontFamily {
  family: string;
  faceCount: number;
  isNerdFont: boolean;
}

export interface FontFaceData {
  /// Raw TTF/OTF bytes, sent from Rust over IPC as a number array.
  data: number[];
  /// CSS font-weight (100..900).
  weight: number;
  italic: boolean;
  /// CSS font-stretch keyword index (1..9).
  stretch: number;
}

// ── Unified tab model ──────────────────────────────────────────────

export type TabKind = "terminal" | "panel";

interface TabBase {
  id: string;
  kind: TabKind;
  label: string;
}

export interface TerminalTabData extends TabBase {
  id: TerminalViewId;
  kind: "terminal";
  terminalId: TerminalId;
  repoPath: string;
  commandName: string | null;
  terminalRevision: TerminalRevision;
  lifecycle: TerminalLifecycle;
  /** Opaque module session identity; native PTY identity stays host-owned. */
  moduleSessionId?: string;
  modulePresentation?: ModuleTerminalSessionPresentation;
}

export interface ContributedPanelTabData extends TabBase {
  kind: "panel";
  panelId: `${string}.${string}`;
}

export type PanelTabData = ContributedPanelTabData;
export type UnifiedTab = TerminalTabData | PanelTabData;

export type TabCycleDirection = 1 | -1;

export function contributedPanelTabId(panelId: `${string}.${string}`): string {
  return `panel-${panelId}`;
}

// ── Tab activity tracking ────────────────────────────────────────────

export interface TabActivity {
  alive: boolean;
  active: boolean;
  exitCode: number | null;
  bell: boolean;
  lastOutputAt: number | null;
  lastAttentionAt: number | null;
  lastNotificationMessage: string | null;
  agentState: "idle" | "working" | "blocked" | null;
  agentAttention: "blocked" | "completed" | null;
  agentRevision: number | null;
  agentUpdatedAt: number | null;
  agentSource: string | null;
  agentMessage: string | null;
}
