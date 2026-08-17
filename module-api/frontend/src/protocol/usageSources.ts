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

export type UsageSourceKind = "provider-quota" | "local-transcript";
export type UsageSourcesGrant =
  | "usage-source.read"
  | "usage-source.refresh"
  | "usage-source.observe";
export type UsageSourceType = "provider" | "local";
export type UsageConfidence = "official" | "observed" | "estimated";
export type UsageCostKind = "recorded" | "estimated" | "included" | "free" | "mixed" | "unknown";

/** Reviewed source identity. Native paths and credential bytes are not public data. */
export interface UsageSourceDescriptor {
  readonly sourceId: UsageProvider;
  readonly kinds: readonly UsageSourceKind[];
  readonly authority: "host-managed";
}

/** Provider quota fact produced inside the credential boundary. */
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

/** Normalized transcript event or durable daily rollup. */
export interface UsageSourceRecord {
  readonly grain: "message" | "daily";
  readonly provider: UsageProvider;
  readonly sessionId: string | null;
  readonly date: string | null;
  readonly project: string | null;
  readonly model: string | null;
  readonly timestamp: number | null;
  readonly tokensInput: number;
  readonly tokensOutput: number;
  readonly tokensCacheWrite: number;
  readonly tokensCacheRead: number;
  readonly tokensThoughts: number;
  readonly tokensTotal: number;
  readonly messageCount: number;
  readonly pricingProvider: string;
  readonly recordedCost: number | null;
}

/** Redacted state of one credential-bound provider quota source. */
export interface UsageProviderObservation {
  readonly provider: UsageProvider;
  readonly available: boolean;
  readonly fetchedAt: string | null;
  readonly summaryWindows: readonly UsageProviderWindow[];
  readonly extraWindows: readonly UsageProviderWindow[];
}

/** Raw semantic facts. It contains no pricing, aliases, totals, or UI projections. */
export interface UsageSourceDataset {
  readonly capturedAt: string;
  readonly records: readonly UsageSourceRecord[];
  readonly providerObservations: readonly UsageProviderObservation[];
}

export interface InspectUsageSourceInput {
  readonly kind: "source-dataset";
  readonly sourceIds?: readonly UsageProvider[];
}

export interface UsageSourceInspection {
  readonly kind: "source-dataset";
  readonly sources: readonly UsageSourceDescriptor[];
  readonly dataset: UsageSourceDataset;
}

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
  2,
);
