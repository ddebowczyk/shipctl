import type { ModuleTerminalSessionPresentation } from "@shep/module-api";

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
  scrollback: number;
  fontFamily: string;
  fontSize: number;
  urlAllowlist: string[];
}

export interface SidebarSettings {
  fontSize: number;
  fontFamily: string;
  width: number;
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
  kind: "terminal";
  ptyId: number;
  repoPath: string;
  commandName: string | null;
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
}

// ── Pi config ──────────────────────────────────────────────────────

export interface PiSettings {
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultThinkingLevel: string | null;
}

export interface PiConfig {
  settings: PiSettings;
  configuredProviders: string[];
}

// ── PTY output ──────────────────────────────────────────────────────

export type PtyOutput =
  | { event: "data"; data: string }
  | { event: "exit"; data: { code: number } };

export interface PtyColorTheme {
  foreground: string;
  background: string;
  palette: string[];
}
