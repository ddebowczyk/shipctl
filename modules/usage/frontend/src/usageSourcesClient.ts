import {
  usageSourcesService,
  type ModuleActivationContext,
  type SemanticEventLease,
  type SemanticRequestOperation,
  type UsageSourceId,
  type UsageSourceResourceRequest,
  type UsageSourceResourceResult,
  type UsageSourcesErrorCode,
  type UsageSourcesService,
} from "@shipctl/module-api";

import type { ProviderUsageSnapshot, UsageOverview, UsageTimeWindow } from "./types";
import {
  createUsageSourcePolicy,
  type UsageSourcePolicy,
  type UsageSourceResourceReader,
} from "./usageSourcePolicy";
import { projectUsageOverview, projectUsageSnapshots } from "./usageProjection";

export class UsageSourcesClientError extends Error {
  readonly code: UsageSourcesErrorCode;

  constructor(code: UsageSourcesErrorCode, message: string) {
    super(message);
    this.name = "UsageSourcesClientError";
    this.code = code;
  }
}

async function execute<Input, Output>(
  operation: SemanticRequestOperation<Input, Output, UsageSourcesErrorCode>,
  input: Input,
): Promise<Output> {
  const outcome = await operation.execute(input);
  if (!outcome.result.ok) {
    throw new UsageSourcesClientError(
      outcome.result.error.code,
      outcome.result.error.message,
    );
  }
  return outcome.result.value;
}

function selectedSourceIds(
  policy: UsageSourcePolicy,
  requested: readonly UsageSourceId[] | undefined,
): readonly UsageSourceId[] {
  const sourceIds = requested === undefined ? policy.sourceIds : [...requested];
  if (
    sourceIds.length === 0
    || new Set(sourceIds).size !== sourceIds.length
    || sourceIds.some((sourceId) => !policy.sourceIds.includes(sourceId))
  ) {
    throw new UsageSourcesClientError(
      "usage-sources.invalid-request",
      "Usage source selection is not declared by this artifact",
    );
  }
  return sourceIds;
}

async function inspect(
  service: UsageSourcesService,
  sourceIds: readonly UsageSourceId[],
) {
  const inspection = await execute(service.inspectSource, {
    kind: "source-dataset",
    sourceIds,
  });
  if (inspection.kind !== "source-dataset") {
    throw new UsageSourcesClientError(
      "usage-sources.transport-failed",
      "Usage source response did not match its request",
    );
  }
  return inspection.dataset;
}

function resourceReader(
  service: UsageSourcesService,
  sourceId: UsageSourceId,
): UsageSourceResourceReader {
  return Object.freeze({
    read(request: UsageSourceResourceRequest): Promise<UsageSourceResourceResult> {
      return execute(service.readResource, { sourceId, request });
    },
  });
}

export interface UsageSourcesClient {
  getAllUsageSnapshots(): Promise<readonly ProviderUsageSnapshot[]>;
  getUsageOverview(window: UsageTimeWindow): Promise<UsageOverview>;
  refreshUsageData(sourceIds?: readonly UsageSourceId[]): Promise<void>;
  subscribeChanges(listener: () => void | Promise<void>): Promise<SemanticEventLease>;
}

export function createUsageSourcesClient(
  service: UsageSourcesService,
  policy: UsageSourcePolicy = createUsageSourcePolicy(),
): UsageSourcesClient {
  const allSources = () => selectedSourceIds(policy, undefined);
  const client: UsageSourcesClient = {
    async getAllUsageSnapshots() {
      const dataset = await inspect(service, allSources());
      return projectUsageSnapshots(policy.present(dataset), policy.sourceIds);
    },
    async getUsageOverview(window) {
      const dataset = await inspect(service, allSources());
      return projectUsageOverview(policy.present(dataset), window);
    },
    async refreshUsageData(requested) {
      const sourceIds = selectedSourceIds(policy, requested);
      const settled = await Promise.allSettled(sourceIds.map(async (sourceId) => (
        policy.collect(sourceId, resourceReader(service, sourceId))
      )));
      const collections = settled.flatMap((result) => (
        result.status === "fulfilled" ? [result.value] : []
      ));
      if (collections.length === 0) {
        const failure = settled.find((result) => result.status === "rejected");
        throw new UsageSourcesClientError(
          "usage-sources.unavailable",
          failure?.status === "rejected" && failure.reason instanceof Error
            ? failure.reason.message
            : "Usage source collection is unavailable",
        );
      }
      const accepted = await execute(service.refreshSources, {
        sourceIds: collections.map(({ sourceId }) => sourceId),
        updates: collections.map(({ sourceId, records }) => ({ sourceId, records })),
      });
      if (accepted.acceptedSourceIds.length !== collections.length) {
        throw new UsageSourcesClientError(
          "usage-sources.transport-failed",
          "Usage source refresh receipt did not match its request",
        );
      }
      policy.update(collections);
    },
    subscribeChanges: (listener) => service.observeSource.subscribe(
      { sourceIds: allSources() },
      listener,
    ),
  };
  return Object.freeze(client);
}

const ACTIVATION_CLIENTS = new WeakMap<ModuleActivationContext, UsageSourcesClient>();

export function usageSourcesClientFor(
  activation: ModuleActivationContext,
): UsageSourcesClient {
  const existing = ACTIVATION_CLIENTS.get(activation);
  if (existing) return existing;
  const client = createUsageSourcesClient(
    activation.services.require(usageSourcesService),
    createUsageSourcePolicy(),
  );
  ACTIVATION_CLIENTS.set(activation, client);
  return client;
}

let activeClient: UsageSourcesClient | null = null;

export function configureUsageSourcesClient(client: UsageSourcesClient | null): void {
  activeClient = client;
}

export function activeUsageSourcesClient(): UsageSourcesClient {
  if (!activeClient) throw new Error("Usage Sources service is unavailable");
  return activeClient;
}
