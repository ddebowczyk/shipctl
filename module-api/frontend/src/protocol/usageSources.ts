import { defineSemanticService } from "./semanticServices.ts";
import type {
  SemanticEventSource,
  SemanticRequestOperation,
} from "./semanticServices";

/**
 * An opaque plugin-declared source identity.
 *
 * The native capability validates its syntax and resource bounds, but never
 * owns a closed product-provider list. A Usage artifact can therefore add a
 * source after the host has shipped, provided it uses the existing grant.
 */
export type UsageSourceId = string;

export type UsageSourcesGrant =
  | "usage-source.read"
  | "usage-source.refresh"
  | "usage-source.observe";

/** Normalized transcript event or durable daily rollup. */
export interface UsageSourceRecord {
  readonly grain: "message" | "daily";
  readonly sourceId: UsageSourceId;
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

/** Raw semantic facts. It contains no source policy, quota cache, or UI projection. */
export interface UsageSourceDataset {
  readonly capturedAt: string;
  readonly records: readonly UsageSourceRecord[];
}

export interface InspectUsageSourceInput {
  readonly kind: "source-dataset";
  readonly sourceIds: readonly UsageSourceId[];
}

export interface UsageSourceInspection {
  readonly kind: "source-dataset";
  readonly dataset: UsageSourceDataset;
}

export interface RefreshUsageSourcesInput {
  readonly sourceIds: readonly UsageSourceId[];
  /**
   * Normalized policy output supplied by the trusted Usage plugin after it
   * has collected and parsed its own described resources. The host stores
   * opaque source facts; it does not parse provider formats or cache shapes.
   */
  readonly updates?: readonly UsageSourceUpdate[];
}

export interface UsageSourceRefreshReceipt {
  readonly acceptedSourceIds: readonly UsageSourceId[];
}

export interface UsageSourceObservationScope {
  readonly sourceIds: readonly UsageSourceId[];
}

export interface UsageSourcesChanged {
  readonly sourceIds: readonly UsageSourceId[];
}

/** A bounded, generic native resource read used by a plugin-owned collector. */
export type UsageSourceResourceRequest =
  | {
    readonly kind: "file";
    readonly resourceId: string;
    readonly relativePath: string;
    readonly maxBytes?: number;
  }
  | {
    readonly kind: "tree";
    readonly resourceId: string;
    readonly relativePath: string;
    readonly maxFiles?: number;
    readonly maxBytesPerFile?: number;
    readonly extensions?: readonly string[];
  }
  | {
    readonly kind: "sqlite";
    readonly resourceId: string;
    readonly relativePath: string;
    readonly query: string;
    readonly maxRows?: number;
  }
  | {
    readonly kind: "processes";
    readonly resourceId: string;
  }
  | {
    readonly kind: "listening-ports";
    readonly resourceId: string;
  }
  | {
    readonly kind: "http";
    readonly resourceId: string;
    readonly url: string;
    readonly method: "GET" | "POST";
    readonly headers?: readonly { readonly name: string; readonly value: string }[];
    readonly body?: string;
    readonly maxBytes?: number;
  }
  | {
    readonly kind: "keychain-password";
    readonly resourceId: string;
    readonly service: string;
    readonly account?: string;
  };

export interface UsageSourceResourceReadInput {
  readonly sourceId: UsageSourceId;
  readonly request: UsageSourceResourceRequest;
}

export type UsageSourceResourceResult =
  | {
    readonly kind: "file";
    readonly resourceId: string;
    readonly content: string;
  }
  | {
    readonly kind: "tree";
    readonly resourceId: string;
    readonly files: readonly { readonly relativePath: string; readonly content: string }[];
  }
  | {
    readonly kind: "sqlite";
    readonly resourceId: string;
    readonly rows: readonly Readonly<Record<string, string | number | boolean | null>>[];
  }
  | {
    readonly kind: "processes" | "listening-ports";
    readonly resourceId: string;
    readonly output: string;
  }
  | {
    readonly kind: "http";
    readonly resourceId: string;
    readonly status: number;
    readonly body: string;
  }
  | {
    readonly kind: "keychain-password";
    readonly resourceId: string;
    readonly secret: string;
  };

/** One plugin-owned replacement for a source's normalized durable facts. */
export interface UsageSourceUpdate {
  readonly sourceId: UsageSourceId;
  readonly records: readonly UsageSourceRecord[];
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
  /**
   * Executes one bounded native resource read. Paths, network destinations,
   * process inspection, and keychain lookups are validated by resource kind;
   * provider selection and response parsing remain in the artifact.
   */
  readonly readResource: SemanticRequestOperation<
    UsageSourceResourceReadInput,
    UsageSourceResourceResult,
    UsageSourcesErrorCode
  >;
  readonly observeSource: SemanticEventSource<
    UsageSourceObservationScope,
    UsageSourcesChanged
  >;
}

export const usageSourcesService = defineSemanticService<UsageSourcesService>(
  "shipctl.usage-sources",
  3,
);
