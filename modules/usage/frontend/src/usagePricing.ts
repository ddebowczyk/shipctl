import pricingSnapshot from "../resources/model_pricing_snapshot.json";

import type { UsageSourceRecord } from "@shipctl/module-api";

import type { UsageCost } from "./types";

interface ModelPricing {
  readonly provider: string;
  readonly modelPattern: string;
  readonly inputPerM: number;
  readonly outputPerM: number;
  readonly cacheReadPerM: number;
  readonly cacheWritePerM: number;
  readonly thoughtsPerM: number;
}

const PRICING = pricingSnapshot as readonly ModelPricing[];

export function unknownCost(): UsageCost {
  return { amount: null, kind: "unknown", basis: "none", confidence: "observed" };
}

function pricingAliases(model: string): readonly string[] {
  const aliases = [model];
  const lower = model.toLowerCase();

  if (lower.includes("gemini 3.5 flash")) aliases.push("gemini-3.5-flash");
  else if (lower.includes("gemini 3.1 pro")) aliases.push("gemini-3.1-pro-preview");
  else if (lower.includes("gemini 3.1 flash") && lower.includes("image")) {
    aliases.push("gemini-3.1-flash-image-preview");
  } else if (lower.includes("gemini 3.1 flash")) aliases.push("gemini-3.1-flash-lite");
  else if (lower.includes("gemini 3 pro") && lower.includes("image")) {
    aliases.push("gemini-3-pro-image-preview");
  } else if (lower.includes("gemini 3 pro")) aliases.push("gemini-3-pro-preview");
  else if (lower.includes("gemini 3 flash")) aliases.push("gemini-3-flash-preview");
  else if (lower.includes("gemini 2.5 pro")) aliases.push("gemini-2.5-pro");
  else if (lower.includes("gemini 2.5 flash") && lower.includes("lite")) {
    aliases.push("gemini-2.5-flash-lite");
  } else if (lower.includes("gemini 2.5 flash")) aliases.push("gemini-2.5-flash");
  else if (lower.includes("gemini 2.0 flash") && lower.includes("lite")) {
    aliases.push("gemini-2.0-flash-lite");
  } else if (lower.includes("gemini 2.0 flash")) aliases.push("gemini-2.0-flash");

  if (lower.includes("claude sonnet 4.6")) aliases.push("claude-sonnet-4-6");
  else if (lower.includes("claude sonnet 4.5")) aliases.push("claude-sonnet-4-5");
  else if (lower.includes("claude sonnet 4")) aliases.push("claude-sonnet-4-0");
  else if (lower.includes("claude opus 4.8")) aliases.push("claude-opus-4-8");
  else if (lower.includes("claude opus 4.7")) aliases.push("claude-opus-4-7");
  else if (lower.includes("claude opus 4.6")) aliases.push("claude-opus-4-6");
  else if (lower.includes("claude opus 4.5")) aliases.push("claude-opus-4-5");
  else if (lower.includes("claude opus 4.1")) aliases.push("claude-opus-4-1");
  else if (lower.includes("claude opus 4")) aliases.push("claude-opus-4-0");
  else if (lower.includes("claude haiku 4.5")) aliases.push("claude-haiku-4-5");
  else if (lower.includes("claude fable 5")) aliases.push("claude-fable-5");

  return aliases;
}

function findPricing(provider: string, model: string): ModelPricing | undefined {
  for (const alias of pricingAliases(model)) {
    const exact = PRICING.find((row) => (
      row.provider === provider && row.modelPattern === alias
    ));
    if (exact) return exact;

    const prefix = PRICING
      .filter((row) => row.provider === provider && alias.startsWith(row.modelPattern))
      .sort((left, right) => right.modelPattern.length - left.modelPattern.length)[0];
    if (prefix) return prefix;
  }
  return undefined;
}

function calculatedCost(pricing: ModelPricing, records: readonly UsageSourceRecord[]): number {
  const totals = records.reduce((sum, record) => ({
    input: sum.input + record.tokensInput,
    output: sum.output + record.tokensOutput,
    cacheRead: sum.cacheRead + record.tokensCacheRead,
    cacheWrite: sum.cacheWrite + record.tokensCacheWrite,
    thoughts: sum.thoughts + record.tokensThoughts,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thoughts: 0 });
  return (
    totals.input * pricing.inputPerM
    + totals.output * pricing.outputPerM
    + totals.cacheRead * pricing.cacheReadPerM
    + totals.cacheWrite * pricing.cacheWritePerM
    + totals.thoughts * pricing.thoughtsPerM
  ) / 1_000_000;
}

/** Resolve one provider/model group using provider cost before local pricing. */
export function resolveUsageCost(records: readonly UsageSourceRecord[]): UsageCost {
  if (records.length === 0) return unknownCost();
  const recorded = records.filter((record) => record.recordedCost !== null);
  if (recorded.length > 0) {
    const amount = recorded.reduce((sum, record) => sum + (record.recordedCost ?? 0), 0);
    return {
      amount,
      kind: amount === 0 ? "free" : "recorded",
      basis: "provider",
      confidence: "official",
    };
  }

  const first = records[0];
  const pricing = findPricing(first.pricingProvider, first.model ?? "unknown");
  return pricing
    ? {
        amount: calculatedCost(pricing, records),
        kind: "estimated",
        basis: "local-pricing",
        confidence: "estimated",
      }
    : unknownCost();
}

export function combineUsageCosts(costs: readonly UsageCost[]): UsageCost {
  const known = costs.filter((cost): cost is UsageCost & { amount: number } => (
    cost.amount !== null
  ));
  if (known.length === 0) return unknownCost();
  const first = known[0];
  const mixed = known.some((cost) => (
    cost.kind !== first.kind
    || cost.basis !== first.basis
    || cost.confidence !== first.confidence
  ));
  return mixed
    ? {
        amount: known.reduce((sum, cost) => sum + cost.amount, 0),
        kind: "mixed",
        basis: "none",
        confidence: "observed",
      }
    : {
        amount: known.reduce((sum, cost) => sum + cost.amount, 0),
        kind: first.kind,
        basis: first.basis,
        confidence: first.confidence,
      };
}

export function groupedUsageCost(records: readonly UsageSourceRecord[]): UsageCost {
  const groups = new Map<string, UsageSourceRecord[]>();
  for (const record of records) {
    const key = `${record.pricingProvider}\u0000${record.model ?? "unknown"}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return combineUsageCosts([...groups.values()].map(resolveUsageCost));
}
