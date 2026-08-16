import {
  usageSourcesService,
  type ModuleActivationContext,
  type ProviderUsageSnapshot,
  type SemanticEventLease,
  type SemanticRequestOperation,
  type UsageOverview,
  type UsageProvider,
  type UsageSourcesErrorCode,
  type UsageSourcesService,
  type UsageTimeWindow,
} from "@shipctl/module-api";

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

export interface UsageSourcesClient {
  getAllUsageSnapshots(): Promise<readonly ProviderUsageSnapshot[]>;
  getUsageOverview(window: UsageTimeWindow): Promise<UsageOverview>;
  refreshUsageData(sourceIds?: readonly UsageProvider[]): Promise<void>;
  subscribeChanges(listener: () => void | Promise<void>): Promise<SemanticEventLease>;
}

export function createUsageSourcesClient(service: UsageSourcesService): UsageSourcesClient {
  const client: UsageSourcesClient = {
    async getAllUsageSnapshots() {
      const inspection = await execute(service.inspectSource, { kind: "source-snapshots" });
      if (inspection.kind !== "source-snapshots") {
        throw new UsageSourcesClientError(
          "usage-sources.transport-failed",
          "Usage source response did not match its request",
        );
      }
      return inspection.snapshots;
    },
    async getUsageOverview(window) {
      const inspection = await execute(service.inspectSource, {
        kind: "legacy-overview-projection",
        window,
      });
      if (inspection.kind !== "legacy-overview-projection") {
        throw new UsageSourcesClientError(
          "usage-sources.transport-failed",
          "Usage source response did not match its request",
        );
      }
      return inspection.overview;
    },
    async refreshUsageData(sourceIds) {
      await execute(service.refreshSources, sourceIds === undefined ? {} : { sourceIds });
    },
    subscribeChanges: (listener) => service.observeSource.subscribe({}, listener),
  };
  return Object.freeze(client);
}

export function usageSourcesClientFor(
  activation: ModuleActivationContext,
): UsageSourcesClient {
  return createUsageSourcesClient(activation.services.require(usageSourcesService));
}

let activeClient: UsageSourcesClient | null = null;

export function configureUsageSourcesClient(client: UsageSourcesClient | null): void {
  activeClient = client;
}

export function activeUsageSourcesClient(): UsageSourcesClient {
  if (!activeClient) throw new Error("Usage Sources service is unavailable");
  return activeClient;
}
