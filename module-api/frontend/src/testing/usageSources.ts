import {
  usageSourcesService,
  type InspectUsageSourceInput,
  type RefreshUsageSourcesInput,
  type UsageSourceDataset,
  type UsageSourceId,
  type UsageSourceObservationScope,
  type UsageSourceRefreshReceipt,
  type UsageSourceResourceReadInput,
  type UsageSourceResourceResult,
  type UsageSourcesChanged,
  type UsageSourcesErrorCode,
  type UsageSourcesGrant,
  type UsageSourcesService,
} from "../protocol/usageSources";
import type { SemanticServiceError } from "../protocol/semanticServices";
import type {
  SemanticEventLease,
  SemanticEventRecord,
  SemanticServiceProvider,
  SemanticServiceProviderContext,
} from "../host/semanticServices";

import {
  createFakeRequestOperation,
  type FakeRequestTrace,
} from "./semanticServices";

export type FakeUsageSourcesOperation =
  | "inspect-source"
  | "refresh-sources"
  | "read-resource";

type FakeUsageSourcesInput =
  | InspectUsageSourceInput
  | RefreshUsageSourcesInput
  | UsageSourceResourceReadInput;

export interface FakeUsageSourcesTrace {
  readonly operation: FakeUsageSourcesOperation;
  readonly request: FakeRequestTrace<FakeUsageSourcesInput>;
}

export interface FakeUsageSourcesProviderOptions {
  readonly dataset?: UsageSourceDataset;
  readonly deniedGrants?: readonly UsageSourcesGrant[];
  readonly trace?: FakeUsageSourcesTrace[];
  readonly changes?: FakeUsageSourceChangeController;
  readonly readResource?: (
    input: UsageSourceResourceReadInput,
  ) => UsageSourceResourceResult | Promise<UsageSourceResourceResult>;
}

class FakeUsageSourcesFailure extends Error {
  readonly code: UsageSourcesErrorCode;

  constructor(code: UsageSourcesErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

const CANCELLED = {
  code: "usage-sources.cancelled",
  message: "Usage source request was cancelled",
  retryable: false,
} as const;

const DISPOSED = {
  code: "usage-sources.activation-disposed",
  message: "The module activation is no longer active",
  retryable: false,
} as const;

const EMPTY_DATASET: UsageSourceDataset = Object.freeze({
  capturedAt: "1970-01-01T00:00:00Z",
  records: Object.freeze([]),
});

function failedError(error: unknown): SemanticServiceError<UsageSourcesErrorCode> {
  if (error instanceof FakeUsageSourcesFailure) {
    return { code: error.code, message: error.message, retryable: false };
  }
  return {
    code: "usage-sources.transport-failed",
    message: "The fake usage source provider failed",
    retryable: false,
  };
}

function requireGrant(
  options: FakeUsageSourcesProviderOptions,
  grant: UsageSourcesGrant,
): void {
  if (options.deniedGrants?.includes(grant)) {
    throw new FakeUsageSourcesFailure(
      "usage-sources.denied",
      `Fake usage source grant denied: ${grant}`,
    );
  }
}

function validSourceId(value: unknown): value is UsageSourceId {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

function normalizedSourceIds(sourceIds: readonly UsageSourceId[]): readonly UsageSourceId[] {
  if (
    sourceIds.length === 0
    || sourceIds.length > 64
    || !sourceIds.every(validSourceId)
    || new Set(sourceIds).size !== sourceIds.length
  ) {
    throw new FakeUsageSourcesFailure(
      "usage-sources.invalid-request",
      "Usage source identity is invalid",
    );
  }
  return [...sourceIds];
}

function operation<Input extends FakeUsageSourcesInput, Output>(
  context: SemanticServiceProviderContext,
  name: FakeUsageSourcesOperation,
  options: FakeUsageSourcesProviderOptions,
  handle: (input: Input) => Output | Promise<Output>,
) {
  const traces: FakeRequestTrace<Input>[] = [];
  const request = createFakeRequestOperation({
    context,
    policy: POLICY,
    handle: ({ input }) => handle(input),
    failedError,
    cancelledError: CANCELLED,
    disposedError: DISPOSED,
    trace: traces,
  });
  const execute = request.execute.bind(request);
  return Object.freeze({
    policy: request.policy,
    async execute(input: Input, requestOptions?: Parameters<typeof execute>[1]) {
      const traceCount = traces.length;
      const outcome = await execute(input, requestOptions);
      const captured = traces[traceCount];
      if (captured) {
        options.trace?.push({
          operation: name,
          request: captured as FakeRequestTrace<FakeUsageSourcesInput>,
        });
      }
      return outcome;
    },
  });
}

function filterDataset(
  dataset: UsageSourceDataset,
  sourceIds: readonly UsageSourceId[],
): UsageSourceDataset {
  return {
    capturedAt: dataset.capturedAt,
    records: dataset.records.filter(({ sourceId }) => sourceIds.includes(sourceId)),
  };
}

function emptyResourceResult(input: UsageSourceResourceReadInput): UsageSourceResourceResult {
  const { request } = input;
  switch (request.kind) {
    case "file": return { kind: "file", resourceId: request.resourceId, content: "" };
    case "tree": return { kind: "tree", resourceId: request.resourceId, files: [] };
    case "sqlite": return { kind: "sqlite", resourceId: request.resourceId, rows: [] };
    case "processes": return { kind: "processes", resourceId: request.resourceId, output: "" };
    case "listening-ports": return { kind: "listening-ports", resourceId: request.resourceId, output: "" };
    case "http": return { kind: "http", resourceId: request.resourceId, status: 200, body: "" };
    case "keychain-password": return { kind: "keychain-password", resourceId: request.resourceId, secret: "" };
  }
}

interface FakeUsageSourceSubscription {
  readonly context: SemanticServiceProviderContext;
  readonly sourceIds: readonly UsageSourceId[];
  readonly listener: (
    event: SemanticEventRecord<UsageSourcesChanged>,
  ) => void | Promise<void>;
  readonly dispose: () => Promise<void>;
  active: boolean;
  sequence: number;
  queue: Promise<void>;
}

/** Drives source-change events for one or more fake activation bindings. */
export class FakeUsageSourceChangeController {
  readonly #subscriptions = new Set<FakeUsageSourceSubscription>();

  subscribe(
    context: SemanticServiceProviderContext,
    sourceIds: readonly UsageSourceId[],
    listener: FakeUsageSourceSubscription["listener"],
  ): SemanticEventLease {
    let subscription: FakeUsageSourceSubscription;
    const owned = context.own(async () => {
      subscription.active = false;
      this.#subscriptions.delete(subscription);
      await subscription.queue;
    });
    subscription = {
      context,
      sourceIds,
      listener,
      active: true,
      sequence: 0,
      queue: Promise.resolve(),
      dispose: () => owned.dispose(),
    };
    this.#subscriptions.add(subscription);
    return Object.freeze({
      get disposed() { return owned.disposed; },
      dispose: subscription.dispose,
    });
  }

  async publish(sourceIds: readonly UsageSourceId[]): Promise<void> {
    const normalized = normalizedSourceIds(sourceIds);
    const settlements: Promise<void>[] = [];
    for (const subscription of this.#subscriptions) {
      const matching = normalized.filter((sourceId) => subscription.sourceIds.includes(sourceId));
      if (!subscription.active || !subscription.context.active || matching.length === 0) continue;
      subscription.sequence += 1;
      const event = {
        sourceId: "shipctl.usage-sources.changed",
        sequence: subscription.sequence,
        value: { sourceIds: matching },
      };
      subscription.queue = subscription.queue.then(async () => {
        if (subscription.active && subscription.context.active) {
          await subscription.listener(event);
        }
      });
      settlements.push(subscription.queue);
    }
    await Promise.all(settlements);
  }
}

/** Tauri-free generic Usage Sources provider for artifact workflow tests. */
export function createFakeUsageSourcesServiceProvider(
  options: FakeUsageSourcesProviderOptions = {},
): SemanticServiceProvider<UsageSourcesService> {
  return {
    service: usageSourcesService,
    bind(context) {
      const changes = options.changes ?? new FakeUsageSourceChangeController();
      let dataset = options.dataset ?? EMPTY_DATASET;
      return Object.freeze({
        inspectSource: operation<InspectUsageSourceInput, { readonly kind: "source-dataset"; readonly dataset: UsageSourceDataset }>(
          context,
          "inspect-source",
          options,
          (input) => {
            requireGrant(options, "usage-source.read");
            if (input.kind !== "source-dataset") {
              throw new FakeUsageSourcesFailure(
                "usage-sources.invalid-request",
                "Usage source request is invalid",
              );
            }
            return {
              kind: "source-dataset",
              dataset: filterDataset(dataset, normalizedSourceIds(input.sourceIds)),
            };
          },
        ),
        refreshSources: operation<RefreshUsageSourcesInput, UsageSourceRefreshReceipt>(
          context,
          "refresh-sources",
          options,
          async (input) => {
            requireGrant(options, "usage-source.refresh");
            const acceptedSourceIds = normalizedSourceIds(input.sourceIds);
            if (input.updates !== undefined) {
              const updateIds = input.updates.map(({ sourceId }) => sourceId);
              if (
                updateIds.length !== acceptedSourceIds.length
                || new Set(updateIds).size !== updateIds.length
                || updateIds.some((sourceId) => !acceptedSourceIds.includes(sourceId))
                || input.updates.some((update) => update.records.some((record) => record.sourceId !== update.sourceId))
              ) {
                throw new FakeUsageSourcesFailure(
                  "usage-sources.invalid-request",
                  "Usage source updates are invalid",
                );
              }
              dataset = {
                capturedAt: dataset.capturedAt,
                records: [
                  ...dataset.records.filter(({ sourceId }) => !acceptedSourceIds.includes(sourceId)),
                  ...input.updates.flatMap(({ records }) => records),
                ],
              };
            }
            await changes.publish(acceptedSourceIds);
            return { acceptedSourceIds };
          },
        ),
        readResource: operation<UsageSourceResourceReadInput, UsageSourceResourceResult>(
          context,
          "read-resource",
          options,
          async (input) => {
            requireGrant(options, "usage-source.read");
            normalizedSourceIds([input.sourceId]);
            return options.readResource?.(input) ?? emptyResourceResult(input);
          },
        ),
        observeSource: Object.freeze({
          async subscribe(
            scope: UsageSourceObservationScope,
            listener: FakeUsageSourceSubscription["listener"],
          ) {
            requireGrant(options, "usage-source.observe");
            if (!context.active) throw new Error(DISPOSED.message);
            return changes.subscribe(
              context,
              normalizedSourceIds(scope.sourceIds),
              listener,
            );
          },
        }),
      });
    },
  };
}
