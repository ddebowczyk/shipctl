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

// ── Usage ──────────────────────────────────────────────────────────

export type UsageProvider = "codex" | "claude" | "antigravity" | "gemini" | "opencode" | "pi";

export type BudgetMode = "subscription" | "custom";

export interface ProviderBudgetConfig {
  show: boolean;
  budgetMode: BudgetMode;
  monthlyBudget: number | null;
}

export interface UsageSettings {
  claude: ProviderBudgetConfig;
  codex: ProviderBudgetConfig;
  antigravity: ProviderBudgetConfig;
  gemini: ProviderBudgetConfig;
  opencode: ProviderBudgetConfig;
  pi: ProviderBudgetConfig;
}
export type UsageSourceType = "provider" | "local";
export type UsageConfidence = "official" | "observed" | "estimated";
export type UsageCostKind = "recorded" | "estimated" | "included" | "free" | "unknown" | "mixed";
export type UsageCostBasis = "provider" | "local-pricing" | "subscription" | "gateway" | "none";

export interface UsageCost {
  amount: number | null;
  kind: UsageCostKind;
  basis: UsageCostBasis;
  confidence: UsageConfidence;
}

export interface UsageWindowSnapshot {
  provider: UsageProvider;
  windowId: string;
  window: string;
  label: string;
  scope: "session" | "plan" | "billing" | "reporting";
  limit: number | null;
  used: number | null;
  sourceType: UsageSourceType;
  confidence: UsageConfidence;
  costKind: UsageCostKind;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAt: string | null;
  tokenTotal: number | null;
  paceStatus: string | null;
}

export interface UsageNamedTokens {
  name: string;
  tokens: number;
  cost: number | null;
  costDetail: UsageCost;
}

export interface UsageTask {
  id: string;
  label: string;
  tokens: number;
  cost: number | null;
  costDetail: UsageCost;
  model: string | null;
  project: string | null;
  updatedAt: string | null;
}

export interface UsageProject {
  name: string;
  tokens: number;
  cost: number | null;
  costDetail: UsageCost;
  sessions: number | null;
}

export interface UsageProjectAliasReviewItem {
  rawLabel: string;
  provider: UsageProvider;
  canonicalId: string;
  displayName: string;
  confidence: number;
  reason: string;
  sessions: number;
  tokens: number;
}

export interface UsageTrendProviderValue {
  provider: UsageProvider;
  tokens: number;
  cost: number | null;
  costDetail: UsageCost;
}

export interface UsageTrendBucket {
  start: number;
  end: number;
  label: string;
  tokens: number;
  cost: number | null;
  costDetail: UsageCost;
  providers: UsageTrendProviderValue[];
}

export interface UsageOverviewProvider {
  provider: UsageProvider;
  tokens: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  tokensThoughts: number;
  cost: number | null;
  costDetail: UsageCost;
  sharePercent: number;
  trend: number[];
}

export interface UsageBreakdownItem {
  provider: UsageProvider;
  label: string;
  tokens: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  tokensThoughts: number;
  cost: number | null;
  costDetail: UsageCost;
  sessions: number | null;
  trend: number[];
}

export interface UsageOverview {
  window: string;
  totalTokens: number;
  totalCost: number | null;
  totalCostDetail: UsageCost;
  activeProjects: number;
  activeSessions: number;
  providers: UsageOverviewProvider[];
  trend: UsageTrendBucket[];
  topModels: UsageBreakdownItem[];
  topProjects: UsageBreakdownItem[];
}

export interface LocalUsageDetails {
  sourceType: "local";
  confidence: UsageConfidence;
  tokensTotal: number;
  tokensInput: number | null;
  tokensOutput: number | null;
  tokensCached: number | null;
  tokensThoughts: number | null;
  tokens5h: number;
  tokens7d: number;
  tokens30d: number;
  costTotal: number | null;
  costTotalDetail: UsageCost;
  costMonth: number | null;
  costMonthDetail: UsageCost;
  cost5h: number | null;
  cost5hDetail: UsageCost;
  cost7d: number | null;
  cost7dDetail: UsageCost;
  cost30d: number | null;
  cost30dDetail: UsageCost;
  topModels: UsageNamedTokens[];
  topTasks: UsageTask[];
  topProjects: UsageProject[];
}

export interface ProviderUsageSnapshot {
  provider: UsageProvider;
  status: string;
  fetchedAt: string;
  summaryWindows: UsageWindowSnapshot[];
  extraWindows: UsageWindowSnapshot[];
  localDetails: LocalUsageDetails | null;
  error: string | null;
}
