import type {
  UsageProvider,
  UsageProviderObservation,
  UsageProviderWindow,
  UsageSourceDataset,
  UsageSourceRecord,
} from "@shipctl/module-api";

import type {
  LocalUsageDetails,
  ProviderUsageSnapshot,
  UsageBreakdownItem,
  UsageNamedTokens,
  UsageOverview,
  UsageOverviewProvider,
  UsageProject,
  UsageProjectAliasReviewItem,
  UsageTask,
  UsageTimeWindow,
  UsageTrendBucket,
} from "./types";
import { combineUsageCosts, groupedUsageCost, resolveUsageCost } from "./usagePricing";

const PROVIDERS = ["claude", "codex", "antigravity", "gemini", "opencode", "pi"] as const;
const BREAKDOWN_LIMIT = 25;
const FIVE_HOURS = 18_000;
const SEVEN_DAYS = 604_800;
const THIRTY_DAYS = 2_592_000;
const YEAR = 31_536_000;

interface WindowDefinition {
  readonly cutoff: number;
  readonly bucketCount: number;
  readonly mode: "hourly" | "daily";
}

function epoch(capturedAt: string): number {
  const value = Date.parse(capturedAt);
  return Number.isFinite(value) ? Math.floor(value / 1000) : Math.floor(Date.now() / 1000);
}

function messageRecords(dataset: UsageSourceDataset): readonly UsageSourceRecord[] {
  return dataset.records.filter((record) => record.grain === "message" && record.timestamp !== null);
}

function sum(records: readonly UsageSourceRecord[], field: keyof UsageSourceRecord): number {
  return records.reduce((total, record) => {
    const value = record[field];
    return total + (typeof value === "number" ? value : 0);
  }, 0);
}

function groupBy(
  records: readonly UsageSourceRecord[],
  key: (record: UsageSourceRecord) => string,
): Map<string, UsageSourceRecord[]> {
  const groups = new Map<string, UsageSourceRecord[]>();
  for (const record of records) {
    const value = key(record);
    const group = groups.get(value) ?? [];
    group.push(record);
    groups.set(value, group);
  }
  return groups;
}

function distinctSessionCount(records: readonly UsageSourceRecord[]): number {
  return new Set(records.flatMap((record) => (
    record.sessionId === null ? [] : [record.sessionId]
  ))).size;
}

function localMonthStart(now: number): number {
  const date = new Date(now * 1000);
  return Math.floor(new Date(date.getFullYear(), date.getMonth(), 1).getTime() / 1000);
}

function filteredSince(records: readonly UsageSourceRecord[], cutoff: number): UsageSourceRecord[] {
  return records.filter((record) => (record.timestamp ?? -1) >= cutoff);
}

function topModels(records: readonly UsageSourceRecord[]): UsageNamedTokens[] {
  return [...groupBy(records, (record) => record.model ?? "unknown")]
    .map(([name, grouped]) => {
      const costDetail = groupedUsageCost(grouped);
      return { name, tokens: sum(grouped, "tokensTotal"), cost: costDetail.amount, costDetail };
    })
    .sort((left, right) => right.tokens - left.tokens)
    .slice(0, 5);
}

function topTasks(records: readonly UsageSourceRecord[]): UsageTask[] {
  return [...groupBy(records, (record) => record.sessionId ?? "")]
    .map(([id, grouped]) => {
      const model = grouped.reduce<string | null>((current, record) => (
        record.model !== null && (current === null || record.model > current) ? record.model : current
      ), null);
      const pricingProvider = grouped.reduce((current, record) => (
        record.pricingProvider > current ? record.pricingProvider : current
      ), grouped[0]?.pricingProvider ?? "");
      const costDetail = model === null
        ? groupedUsageCost([])
        : resolveUsageCost(grouped.map((record) => ({
            ...record,
            model,
            pricingProvider,
          })));
      const updatedAt = grouped.reduce<number | null>((current, record) => (
        record.timestamp !== null && (current === null || record.timestamp > current)
          ? record.timestamp
          : current
      ), null);
      return {
        id,
        label: id,
        tokens: sum(grouped, "tokensTotal"),
        cost: costDetail.amount,
        costDetail,
        model,
        project: grouped[0]?.project ?? null,
        updatedAt: updatedAt?.toString() ?? null,
      };
    })
    .sort((left, right) => right.tokens - left.tokens)
    .slice(0, 5);
}

function topProjects(records: readonly UsageSourceRecord[]): UsageProject[] {
  return [...groupBy(records, (record) => record.project ?? "unknown")]
    .map(([name, grouped]) => {
      const costDetail = groupedUsageCost(grouped);
      return {
        name,
        tokens: sum(grouped, "tokensTotal"),
        cost: costDetail.amount,
        costDetail,
        sessions: distinctSessionCount(grouped),
      };
    })
    .sort((left, right) => right.tokens - left.tokens)
    .slice(0, 5);
}

function localDetails(
  dataset: UsageSourceDataset,
  provider: UsageProvider,
  now: number,
): LocalUsageDetails {
  const records = messageRecords(dataset).filter((record) => record.provider === provider);
  const t5h = now - FIVE_HOURS;
  const t7d = now - SEVEN_DAYS;
  const t30d = now - THIRTY_DAYS;
  const typed = sum(records, "tokensInput") > 0 || sum(records, "tokensOutput") > 0;
  const detailsFor = (cutoff: number) => groupedUsageCost(filteredSince(records, cutoff));
  const totalCost = groupedUsageCost(records);
  const monthCost = detailsFor(localMonthStart(now));
  const cost5h = detailsFor(t5h);
  const cost7d = detailsFor(t7d);
  const cost30d = detailsFor(t30d);

  return {
    sourceType: "local",
    confidence: "observed",
    tokensTotal: sum(records, "tokensTotal"),
    tokensInput: typed ? sum(records, "tokensInput") : null,
    tokensOutput: typed ? sum(records, "tokensOutput") : null,
    tokensCached: typed ? sum(records, "tokensCacheWrite") + sum(records, "tokensCacheRead") : null,
    tokensThoughts: sum(records, "tokensThoughts") > 0 ? sum(records, "tokensThoughts") : null,
    tokens5h: sum(filteredSince(records, t5h), "tokensTotal"),
    tokens7d: sum(filteredSince(records, t7d), "tokensTotal"),
    tokens30d: sum(filteredSince(records, t30d), "tokensTotal"),
    costTotal: totalCost.amount,
    costTotalDetail: totalCost,
    costMonth: monthCost.amount,
    costMonthDetail: monthCost,
    cost5h: cost5h.amount,
    cost5hDetail: cost5h,
    cost7d: cost7d.amount,
    cost7dDetail: cost7d,
    cost30d: cost30d.amount,
    cost30dDetail: cost30d,
    topModels: topModels(records),
    topTasks: topTasks(records),
    topProjects: topProjects(records),
  };
}

function reportingWindow(
  provider: UsageProvider,
  window: "5h" | "7d" | "30d",
  tokenTotal: number,
): UsageProviderWindow {
  const antigravity = provider === "antigravity";
  const localOnly = provider === "opencode" || provider === "pi";
  return {
    provider,
    windowId: `${provider}-local-${window}`,
    window,
    label: window,
    scope: "reporting",
    limit: null,
    used: null,
    sourceType: "local",
    confidence: antigravity ? "estimated" : "observed",
    costKind: antigravity ? "unknown" : localOnly ? "mixed" : "estimated",
    usedPercent: null,
    remainingPercent: null,
    resetAt: null,
    tokenTotal,
    paceStatus: null,
  };
}

function observationFor(
  observations: readonly UsageProviderObservation[],
  provider: UsageProvider,
): UsageProviderObservation | undefined {
  return observations.find((observation) => observation.provider === provider);
}

export function projectUsageSnapshots(
  dataset: UsageSourceDataset,
): readonly ProviderUsageSnapshot[] {
  const now = epoch(dataset.capturedAt);
  return PROVIDERS.map((provider) => {
    const details = localDetails(dataset, provider, now);
    const observation = observationFor(dataset.providerObservations, provider);
    const summaryWindows = [...(observation?.summaryWindows ?? [])];
    const extraWindows = [...(observation?.extraWindows ?? [])];
    const reporting = provider === "codex" || provider === "claude"
      ? [["30d", details.tokens30d] as const]
      : [["5h", details.tokens5h] as const, ["7d", details.tokens7d] as const, ["30d", details.tokens30d] as const];
    summaryWindows.push(...reporting.map(([window, tokens]) => (
      reportingWindow(provider, window, tokens)
    )));
    const localOnly = provider === "opencode" || provider === "pi";
    return {
      provider,
      status: localOnly ? "ready" : observation?.available ? "ready" : "partial",
      fetchedAt: observation?.fetchedAt ?? dataset.capturedAt,
      summaryWindows,
      extraWindows,
      localDetails: details,
      error: null,
    };
  });
}

function windowDefinition(window: UsageTimeWindow, now: number): WindowDefinition {
  switch (window) {
    case "5h": return { cutoff: now - FIVE_HOURS, bucketCount: 5, mode: "hourly" };
    case "7d": return { cutoff: now - SEVEN_DAYS, bucketCount: 7, mode: "daily" };
    case "30d": return { cutoff: now - THIRTY_DAYS, bucketCount: 30, mode: "daily" };
    case "365d": return { cutoff: now - YEAR, bucketCount: 365, mode: "daily" };
  }
}

function startOfLocalHour(timestamp: number): number {
  const date = new Date(timestamp * 1000);
  date.setMinutes(0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

function localDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localDateStart(date: string): number {
  return Math.floor(new Date(`${date}T00:00:00`).getTime() / 1000);
}

function calendarDayNumber(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

function bucketIndex(
  record: UsageSourceRecord,
  definition: WindowDefinition,
  start: number,
): number | null {
  if (definition.mode === "hourly") {
    if (record.grain !== "message" || record.timestamp === null || record.timestamp < definition.cutoff) {
      return null;
    }
    return Math.floor((startOfLocalHour(record.timestamp) - start) / 3600);
  }
  const date = record.grain === "daily"
    ? record.date
    : record.timestamp !== null && record.timestamp >= definition.cutoff
      ? localDate(record.timestamp)
      : null;
  return date === null
    ? null
    : calendarDayNumber(date) - calendarDayNumber(localDate(definition.cutoff));
}

function trendRecords(dataset: UsageSourceDataset, definition: WindowDefinition): UsageSourceRecord[] {
  const cutoffDate = localDate(definition.cutoff);
  return dataset.records.filter((record) => definition.mode === "hourly"
    ? record.grain === "message" && (record.timestamp ?? -1) >= definition.cutoff
    : (record.grain === "message" && (record.timestamp ?? -1) >= definition.cutoff)
      || (record.grain === "daily" && (record.date ?? "") >= cutoffDate));
}

function projectTrend(
  dataset: UsageSourceDataset,
  definition: WindowDefinition,
): UsageTrendBucket[] {
  const start = definition.mode === "hourly"
    ? startOfLocalHour(definition.cutoff)
    : localDateStart(localDate(definition.cutoff));
  const span = definition.mode === "hourly" ? 3_600 : 86_400;
  const buckets = Array.from({ length: definition.bucketCount }, (_, index) => ({
    start: start + index * span,
    end: start + (index + 1) * span,
    records: [] as UsageSourceRecord[],
  }));
  for (const record of trendRecords(dataset, definition)) {
    const index = bucketIndex(record, definition, start);
    if (index !== null && index >= 0 && index < buckets.length) buckets[index].records.push(record);
  }
  return buckets.map((bucket) => {
    const providers = [...groupBy(bucket.records, (record) => record.provider)]
      .map(([provider, records]) => {
        const costDetail = groupedUsageCost(records);
        return {
          provider: provider as UsageProvider,
          tokens: sum(records, "tokensTotal"),
          cost: costDetail.amount,
          costDetail,
        };
      });
    const costDetail = combineUsageCosts(providers.map((provider) => provider.costDetail));
    return {
      start: bucket.start,
      end: bucket.end,
      label: "",
      tokens: providers.reduce((total, provider) => total + provider.tokens, 0),
      cost: costDetail.amount,
      costDetail,
      providers,
    };
  });
}

function namedTrend(
  records: readonly UsageSourceRecord[],
  definition: WindowDefinition,
  provider: string,
  label: string,
  dimension: "model" | "project",
): number[] {
  const start = definition.mode === "hourly"
    ? startOfLocalHour(definition.cutoff)
    : localDateStart(localDate(definition.cutoff));
  const values = Array.from({ length: definition.bucketCount }, () => 0);
  for (const record of records) {
    const recordLabel = dimension === "model" ? record.model ?? "unknown" : record.project ?? "unknown";
    if (record.provider !== provider || recordLabel !== label) continue;
    const index = bucketIndex(record, definition, start);
    if (index !== null && index >= 0 && index < values.length) values[index] += record.tokensTotal;
  }
  return values;
}

function overviewProviders(
  records: readonly UsageSourceRecord[],
  trend: readonly UsageTrendBucket[],
): UsageOverviewProvider[] {
  const groups = [...groupBy(records, (record) => record.provider)]
    .map(([provider, grouped]) => ({ provider: provider as UsageProvider, grouped }))
    .sort((left, right) => sum(right.grouped, "tokensTotal") - sum(left.grouped, "tokensTotal"));
  const total = groups.reduce((value, group) => value + sum(group.grouped, "tokensTotal"), 0);
  return groups.map(({ provider, grouped }) => {
    const costDetail = groupedUsageCost(grouped);
    const tokens = sum(grouped, "tokensTotal");
    return {
      provider,
      tokens,
      tokensInput: sum(grouped, "tokensInput"),
      tokensOutput: sum(grouped, "tokensOutput"),
      tokensCacheRead: sum(grouped, "tokensCacheRead"),
      tokensCacheWrite: sum(grouped, "tokensCacheWrite"),
      tokensThoughts: sum(grouped, "tokensThoughts"),
      cost: costDetail.amount,
      costDetail,
      sharePercent: total > 0 ? tokens / total * 100 : 0,
      trend: trend.map((bucket) => (
        bucket.providers.find((value) => value.provider === provider)?.tokens ?? 0
      )),
    };
  });
}

function breakdown(
  detailRecords: readonly UsageSourceRecord[],
  allTrendRecords: readonly UsageSourceRecord[],
  definition: WindowDefinition,
  dimension: "model" | "project",
): UsageBreakdownItem[] {
  return [...groupBy(detailRecords, (record) => (
    `${record.provider}\u0000${dimension === "model" ? record.model ?? "unknown" : record.project ?? "unknown"}`
  ))]
    .map(([key, grouped]) => {
      const [provider, label] = key.split("\u0000") as [UsageProvider, string];
      const costDetail = groupedUsageCost(grouped);
      return {
        provider,
        label,
        tokens: sum(grouped, "tokensTotal"),
        tokensInput: sum(grouped, "tokensInput"),
        tokensOutput: sum(grouped, "tokensOutput"),
        tokensCacheRead: sum(grouped, "tokensCacheRead"),
        tokensCacheWrite: sum(grouped, "tokensCacheWrite"),
        tokensThoughts: sum(grouped, "tokensThoughts"),
        cost: costDetail.amount,
        costDetail,
        sessions: dimension === "project"
          ? distinctSessionCount(grouped)
          : null,
        trend: namedTrend(allTrendRecords, definition, provider, label, dimension),
      };
    })
    .sort((left, right) => right.tokens - left.tokens)
    .slice(0, BREAKDOWN_LIMIT);
}

export function projectUsageOverview(
  dataset: UsageSourceDataset,
  window: UsageTimeWindow,
): UsageOverview {
  const definition = windowDefinition(window, epoch(dataset.capturedAt));
  const messages = filteredSince(messageRecords(dataset), definition.cutoff);
  const allTrendRecords = trendRecords(dataset, definition);
  const trend = projectTrend(dataset, definition);
  const providers = overviewProviders(messages, trend);
  const totalCostDetail = combineUsageCosts(providers.map((provider) => provider.costDetail));
  const activeProjects = new Set(allTrendRecords
    .map((record) => record.project ?? "")
    .filter(Boolean)).size;
  const detailedSessions = distinctSessionCount(messages);
  const rolledSessions = definition.mode === "daily"
    ? dataset.records
        .filter((record) => record.grain === "daily" && (record.date ?? "") >= localDate(definition.cutoff))
        .reduce((total, record) => total + record.messageCount, 0)
    : 0;
  return {
    window,
    totalTokens: providers.reduce((total, provider) => total + provider.tokens, 0),
    totalCost: totalCostDetail.amount,
    totalCostDetail,
    activeProjects,
    activeSessions: Math.max(detailedSessions, rolledSessions),
    providers,
    trend,
    topModels: breakdown(messages, allTrendRecords, definition, "model"),
    topProjects: breakdown(messages, allTrendRecords, definition, "project"),
  };
}

interface AliasResolution {
  readonly canonicalId: string;
  readonly displayName: string;
  readonly confidence: number;
  readonly reason: string;
}

function resolveAlias(rawLabel: string): AliasResolution {
  const label = rawLabel.trim();
  if (label === "" || label === "unknown") {
    return { canonicalId: "unknown", displayName: "unknown", confidence: 0.2, reason: "missing-label" };
  }
  const worktree = label.match(/--(?:shipctl|shep)-worktrees-(.+)$/);
  if (worktree?.[1]) {
    const displayName = worktree[1].replace(/^-+|-+$/g, "");
    return { canonicalId: displayName, displayName, confidence: 0.55, reason: "encoded-worktree-label" };
  }
  if (label.startsWith("/") || label.startsWith("~/")) {
    const segments = label.split("/").filter(Boolean);
    const displayName = segments[segments.length - 1] ?? label;
    return { canonicalId: label, displayName, confidence: 0.55, reason: "path-review-required" };
  }
  return { canonicalId: label, displayName: label, confidence: 0.85, reason: "provider-basename" };
}

export function projectUsageProjectAliasReview(
  dataset: UsageSourceDataset,
): readonly UsageProjectAliasReviewItem[] {
  const records = messageRecords(dataset);
  return [...groupBy(records, (record) => `${record.provider}\u0000${record.project ?? "unknown"}`)]
    .map(([key, grouped]) => {
      const [provider, rawLabel] = key.split("\u0000") as [UsageProvider, string];
      return { provider, rawLabel, grouped, resolution: resolveAlias(rawLabel) };
    })
    .filter(({ resolution }) => resolution.confidence < 0.8)
    .map(({ provider, rawLabel, grouped, resolution }) => ({
      provider,
      rawLabel,
      ...resolution,
      sessions: distinctSessionCount(grouped),
      tokens: sum(grouped, "tokensTotal"),
    }))
    .sort((left, right) => right.tokens - left.tokens || left.confidence - right.confidence)
    .slice(0, 50);
}
