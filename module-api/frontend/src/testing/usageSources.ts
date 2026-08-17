import {
  usageSourcesService,
  type InspectUsageSourceInput,
  type RefreshUsageSourcesInput,
  type UsageProvider,
  type UsageSourceDataset,
  type UsageSourceDescriptor,
  type UsageSourceInspection,
  type UsageSourceObservationScope,
  type UsageSourceRefreshReceipt,
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

const PROVIDERS = [
  "claude",
  "codex",
  "antigravity",
  "gemini",
  "opencode",
  "pi",
] as const satisfies readonly UsageProvider[];

export type FakeUsageSourcesOperation = "inspect-source" | "refresh-sources";

export interface FakeUsageSourcesTrace {
  readonly operation: FakeUsageSourcesOperation;
  readonly request: FakeRequestTrace<InspectUsageSourceInput | RefreshUsageSourcesInput>;
}

export interface FakeUsageSourcesProviderOptions {
  readonly descriptors?: readonly UsageSourceDescriptor[];
  readonly dataset?: UsageSourceDataset;
  readonly deniedGrants?: readonly UsageSourcesGrant[];
  readonly trace?: FakeUsageSourcesTrace[];
  readonly changes?: FakeUsageSourceChangeController;
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
  providerObservations: Object.freeze([]),
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

function isProvider(value: string): value is UsageProvider {
  return (PROVIDERS as readonly string[]).includes(value);
}

function normalizedSourceIds(
  sourceIds: readonly UsageProvider[] | undefined,
): readonly UsageProvider[] {
  const values = sourceIds ?? PROVIDERS;
  if (values.length === 0 || !values.every(isProvider)) {
    throw new FakeUsageSourcesFailure(
      "usage-sources.invalid-request",
      "Usage source identity is invalid",
    );
  }
  return [...new Set(values)];
}

function operation<Input, Output>(
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
          request: captured as FakeRequestTrace<InspectUsageSourceInput | RefreshUsageSourcesInput>,
        });
      }
      return outcome;
    },
  });
}

function defaultDescriptors(): readonly UsageSourceDescriptor[] {
  return PROVIDERS.map((sourceId) => ({
    sourceId,
    kinds: sourceId === "opencode" || sourceId === "pi"
      ? ["local-transcript"]
      : ["provider-quota", "local-transcript"],
    authority: "host-managed",
  }));
}

function filterDataset(
  dataset: UsageSourceDataset,
  sourceIds: readonly UsageProvider[],
): UsageSourceDataset {
  return {
    capturedAt: dataset.capturedAt,
    records: dataset.records.filter(({ provider }) => sourceIds.includes(provider)),
    providerObservations: dataset.providerObservations.filter(
      ({ provider }) => sourceIds.includes(provider),
    ),
  };
}

interface FakeUsageSourceSubscription {
  readonly context: SemanticServiceProviderContext;
  readonly sourceIds: readonly UsageProvider[];
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
    sourceIds: readonly UsageProvider[],
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

  async publish(sourceIds?: readonly UsageProvider[]): Promise<void> {
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

/** Tauri-free Usage Sources provider for module workflows. */
export function createFakeUsageSourcesServiceProvider(
  options: FakeUsageSourcesProviderOptions = {},
): SemanticServiceProvider<UsageSourcesService> {
  return {
    service: usageSourcesService,
    bind(context) {
      const changes = options.changes ?? new FakeUsageSourceChangeController();

      return Object.freeze({
        inspectSource: operation<InspectUsageSourceInput, UsageSourceInspection>(
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
            const sourceIds = normalizedSourceIds(input.sourceIds);
            return {
              kind: "source-dataset",
              sources: (options.descriptors ?? defaultDescriptors()).filter(
                ({ sourceId }) => sourceIds.includes(sourceId),
              ),
              dataset: filterDataset(options.dataset ?? EMPTY_DATASET, sourceIds),
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
            await changes.publish(acceptedSourceIds);
            return { acceptedSourceIds };
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
