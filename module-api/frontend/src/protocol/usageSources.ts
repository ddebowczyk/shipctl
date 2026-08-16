import { defineSemanticService } from "./semanticServices.ts";
import type {
  SemanticEventSource,
  SemanticRequestOperation,
} from "./semanticServices";

export type UsageProvider =
  | "claude"
  | "codex"
  | "antigravity"
  | "gemini"
  | "opencode"
  | "pi";

export type UsageTimeWindow = "5h" | "7d" | "30d" | "365d";
export type UsageSourceKind = "provider-quota" | "local-transcript";
export type UsageSourcesGrant =
  | "usage-source.read"
  | "usage-source.refresh"
  | "usage-source.observe";
export type UsageSourceType = "provider" | "local";
export type UsageConfidence = "official" | "observed" | "estimated";
export type UsageCostKind = "recorded" | "estimated" | "included" | "free" | "mixed" | "unknown";
export type UsageCostBasis = "provider" | "local-pricing" | "subscription" | "gateway" | "none";

/** Reviewed source identity. Native paths and credential bytes are not public data. */
export interface UsageSourceDescriptor {
  readonly sourceId: UsageProvider;
  readonly kinds: readonly UsageSourceKind[];
  readonly authority: "host-managed";
}

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
  /** Redacted diagnostic text. It never contains paths or credentials. */
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

export type InspectUsageSourceInput =
  | { readonly kind: "source-snapshots" }
  | {
      /** Transitional projection. Phase D replaces it with TypeScript policy. */
      readonly kind: "legacy-overview-projection";
      readonly window: UsageTimeWindow;
    };

export type UsageSourceInspection =
  | {
      readonly kind: "source-snapshots";
      readonly sources: readonly UsageSourceDescriptor[];
      readonly snapshots: readonly ProviderUsageSnapshot[];
    }
  | {
      /** Compatibility result, not a permanent native capability. */
      readonly kind: "legacy-overview-projection";
      readonly overview: UsageOverview;
    };

export interface RefreshUsageSourcesInput {
  readonly sourceIds?: readonly UsageProvider[];
}

export interface UsageSourceRefreshReceipt {
  readonly acceptedSourceIds: readonly UsageProvider[];
}

export interface UsageSourceObservationScope {
  readonly sourceIds?: readonly UsageProvider[];
}

export interface UsageSourcesChanged {
  readonly sourceIds: readonly UsageProvider[];
}

export type UsageSourcesErrorCode =
  | "usage-sources.transport-failed"
  | "usage-sources.denied"
  | "usage-sources.invalid-request"
  | "usage-sources.unavailable"
  | "usage-sources.cancelled"
  | "usage-sources.activation-disposed";

export interface UsageSourcesService {
  readonly inspectSource: SemanticRequestOperation<
    InspectUsageSourceInput,
    UsageSourceInspection,
    UsageSourcesErrorCode
  >;
  readonly refreshSources: SemanticRequestOperation<
    RefreshUsageSourcesInput,
    UsageSourceRefreshReceipt,
    UsageSourcesErrorCode
  >;
  readonly observeSource: SemanticEventSource<
    UsageSourceObservationScope,
    UsageSourcesChanged
  >;
}

export const usageSourcesService = defineSemanticService<UsageSourcesService>(
  "shipctl.usage-sources",
  1,
);
