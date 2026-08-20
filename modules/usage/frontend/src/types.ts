import type { UsageSourceDataset, UsageSourceId } from "@shipctl/module-api";

/** Product source identities and quota presentation belong to this artifact. */
export type UsageProvider = UsageSourceId;
export type UsageSourceType = "provider" | "local";
export type UsageConfidence = "official" | "observed" | "estimated";
export type UsageCostKind = "recorded" | "estimated" | "included" | "free" | "mixed" | "unknown";

export interface UsageProviderWindow {
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

export interface UsageProviderObservation {
  readonly provider: UsageProvider;
  readonly available: boolean;
  readonly fetchedAt: string | null;
  readonly summaryWindows: readonly UsageProviderWindow[];
  readonly extraWindows: readonly UsageProviderWindow[];
}

export interface UsagePresentationDataset extends UsageSourceDataset {
  readonly providerObservations: readonly UsageProviderObservation[];
}

export type UsageTimeWindow = "5h" | "7d" | "30d" | "365d";
export type UsageCostBasis = "provider" | "local-pricing" | "subscription" | "gateway" | "none";
export type UsageWindowSnapshot = UsageProviderWindow;

export interface UsageCost {
  amount: number | null;
  kind: UsageCostKind;
  basis: UsageCostBasis;
  confidence: UsageConfidence;
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
  window: UsageTimeWindow;
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

/** Module policy record. It is not part of the native Usage Sources service. */
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
