import type { UsageProvider } from "@shipctl/module-api";

export type {
  LocalUsageDetails,
  ProviderUsageSnapshot,
  UsageBreakdownItem,
  UsageConfidence,
  UsageCost,
  UsageCostBasis,
  UsageCostKind,
  UsageNamedTokens,
  UsageOverview,
  UsageOverviewProvider,
  UsageProject,
  UsageProvider,
  UsageSourceType,
  UsageTask,
  UsageTrendBucket,
  UsageTrendProviderValue,
  UsageWindowSnapshot,
} from "@shipctl/module-api";

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
