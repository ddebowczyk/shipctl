import { invoke } from "@tauri-apps/api/core";
import {
  usageSourcesService,
  type InspectUsageSourceInput,
  type ModuleActivationIdentity,
  type RefreshUsageSourcesInput,
  type SemanticCorrelationId,
  type SemanticEventLease,
  type SemanticEventRecord,
  type SemanticResult,
  type SemanticServiceError,
  type SemanticServiceProvider,
  type SemanticServiceProviderContext,
  type UsageProvider,
  type UsageSourceDataset,
  type UsageSourceDescriptor,
  type UsageSourceInspection,
  type UsageSourceObservationScope,
  type UsageSourceRefreshReceipt,
  type UsageSourcesChanged,
  type UsageSourcesErrorCode,
  type UsageSourcesService,
} from "@shipctl/module-api";

import {
  createSemanticRequestAdapter,
  type PrivateSemanticRequestEnvelope,
  type PrivateSemanticRequestTransport,
} from "./semanticServiceAdapter.ts";

const COMMANDS = {
  inspect: "inspect_usage_sources",
  refresh: "refresh_usage_sources",
  release: "release_usage_sources_activation",
} as const;

const CHANGED_SOURCE_ID = "shipctl.usage-sources.changed";

export const USAGE_PROVIDERS = [
  "claude",
  "codex",
  "antigravity",
  "gemini",
  "opencode",
  "pi",
] as const satisfies readonly UsageProvider[];

const DESCRIPTORS: readonly UsageSourceDescriptor[] = Object.freeze([
  { sourceId: "claude", kinds: ["provider-quota", "local-transcript"], authority: "host-managed" },
  { sourceId: "codex", kinds: ["provider-quota", "local-transcript"], authority: "host-managed" },
  { sourceId: "antigravity", kinds: ["provider-quota", "local-transcript"], authority: "host-managed" },
  { sourceId: "gemini", kinds: ["provider-quota", "local-transcript"], authority: "host-managed" },
  { sourceId: "opencode", kinds: ["local-transcript"], authority: "host-managed" },
  { sourceId: "pi", kinds: ["local-transcript"], authority: "host-managed" },
]);

interface NativeInspectUsageSourcesInput {
  readonly sourceIds?: readonly UsageProvider[];
}

type EmptyInput = Readonly<Record<never, never>>;

/** Private transport seam used by the production adapter and property tests. */
export interface NativeUsageSourcesTransport {
  inspectSources(
    request: PrivateSemanticRequestEnvelope<NativeInspectUsageSourcesInput>,
  ): Promise<UsageSourceDataset>;
  refreshSources(
    request: PrivateSemanticRequestEnvelope<RefreshUsageSourcesInput>,
  ): Promise<UsageSourceRefreshReceipt>;
  releaseActivation(
    request: PrivateSemanticRequestEnvelope<EmptyInput>,
  ): Promise<boolean>;
}

export interface UsageSourcesServiceProviderOptions {
  readonly transport?: NativeUsageSourcesTransport;
  readonly createCorrelationId?: () => SemanticCorrelationId;
}

const TAURI_TRANSPORT: NativeUsageSourcesTransport = {
  inspectSources: (request) => invoke(COMMANDS.inspect, { request }),
  refreshSources: (request) => invoke(COMMANDS.refresh, { request }),
  releaseActivation: (request) => invoke(COMMANDS.release, { request }),
};

type RuntimeChangeListener = (sourceIds: readonly UsageProvider[]) => void;

class RuntimeUsageSourceChanges {
  readonly #listeners = new Set<RuntimeChangeListener>();

  subscribe(listener: RuntimeChangeListener): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  publish(sourceIds: readonly UsageProvider[]): void {
    for (const listener of this.#listeners) listener(sourceIds);
  }
}

const RUNTIME_CHANGES = new RuntimeUsageSourceChanges();

const REQUEST_POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

const CANCELLED_ERROR = {
  code: "usage-sources.cancelled",
  message: "Usage source request was cancelled",
  retryable: false,
} as const;

const DISPOSED_ERROR = {
  code: "usage-sources.activation-disposed",
  message: "The module activation is no longer active",
  retryable: false,
} as const;

function correlationId(): SemanticCorrelationId {
  return crypto.randomUUID() as SemanticCorrelationId;
}

function isUsageSourcesErrorCode(value: unknown): value is UsageSourcesErrorCode {
  return typeof value === "string" && [
    "usage-sources.transport-failed",
    "usage-sources.denied",
    "usage-sources.invalid-request",
    "usage-sources.unavailable",
    "usage-sources.cancelled",
    "usage-sources.activation-disposed",
  ].includes(value);
}

function transportError(error: unknown): SemanticServiceError<UsageSourcesErrorCode> {
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && isUsageSourcesErrorCode(error.code)
  ) {
    return {
      code: error.code,
      message: "Usage source request failed",
      retryable: "retryable" in error && error.retryable === true,
    };
  }
  return {
    code: "usage-sources.transport-failed",
    message: "Usage source transport failed",
    retryable: false,
  };
}

function request<Input, Output>(
  context: SemanticServiceProviderContext,
  transport: PrivateSemanticRequestTransport<Input, Output, UsageSourcesErrorCode>,
  createCorrelationId: () => SemanticCorrelationId,
) {
  return createSemanticRequestAdapter({
    activation: context.activation,
    active: () => context.active,
    policy: REQUEST_POLICY,
    transport,
    correlationId: createCorrelationId,
    transportError,
    cancelledError: CANCELLED_ERROR,
    disposedError: DISPOSED_ERROR,
  });
}

function isProvider(value: string): value is UsageProvider {
  return (USAGE_PROVIDERS as readonly string[]).includes(value);
}

function sourceIds(
  input: { readonly sourceIds?: readonly UsageProvider[] },
): readonly UsageProvider[] | null {
  const ids = input.sourceIds ?? USAGE_PROVIDERS;
  return ids.length > 0 && ids.every(isProvider) ? [...new Set(ids)] : null;
}

function invalidRequest<Output>(message: string): SemanticResult<Output, UsageSourcesErrorCode> {
  return {
    ok: false,
    error: { code: "usage-sources.invalid-request", message, retryable: false },
  };
}

function inspectRequest(
  context: SemanticServiceProviderContext,
  transport: NativeUsageSourcesTransport,
  createCorrelationId: () => SemanticCorrelationId,
) {
  return request<InspectUsageSourceInput, UsageSourceInspection>(context, {
    async request(envelope) {
      if (envelope.input.kind !== "source-dataset") {
        return invalidRequest("Usage source request is invalid");
      }
      const requested = sourceIds(envelope.input);
      if (requested === null) {
        return invalidRequest("Usage source identity is invalid");
      }
      const dataset = await transport.inspectSources({
        ...envelope,
        input: { sourceIds: requested },
      });
      if (
        dataset.records.some(({ provider }) => !requested.includes(provider))
        || dataset.providerObservations.some(({ provider }) => !requested.includes(provider))
      ) {
        return invalidRequest("Native usage source response exceeded its requested scope");
      }
      return {
        ok: true,
        value: {
          kind: "source-dataset",
          sources: DESCRIPTORS.filter(({ sourceId }) => requested.includes(sourceId)),
          dataset,
        },
      };
    },
  }, createCorrelationId);
}

function refreshRequest(
  context: SemanticServiceProviderContext,
  transport: NativeUsageSourcesTransport,
  createCorrelationId: () => SemanticCorrelationId,
) {
  return request<RefreshUsageSourcesInput, UsageSourceRefreshReceipt>(context, {
    async request(envelope) {
      const requested = sourceIds(envelope.input);
      if (requested === null) {
        return invalidRequest("Usage source identity is invalid");
      }
      const receipt = await transport.refreshSources({
        ...envelope,
        input: { sourceIds: requested },
      });
      if (
        receipt.acceptedSourceIds.length !== requested.length
        || receipt.acceptedSourceIds.some((sourceId) => !requested.includes(sourceId))
      ) {
        return invalidRequest("Native usage source receipt did not match its request");
      }
      RUNTIME_CHANGES.publish(receipt.acceptedSourceIds);
      return { ok: true, value: receipt };
    },
  }, createCorrelationId);
}

function sourceChanges(context: SemanticServiceProviderContext) {
  let sequence = 0;
  return Object.freeze({
    async subscribe(
      scope: UsageSourceObservationScope,
      listener: (event: SemanticEventRecord<UsageSourcesChanged>) => void | Promise<void>,
    ): Promise<SemanticEventLease> {
      if (!context.active) throw new Error(DISPOSED_ERROR.message);
      const requested = sourceIds(scope);
      if (requested === null) throw new Error("Usage source scope is invalid");
      let active = true;
      let queue = Promise.resolve();
      const unsubscribe = RUNTIME_CHANGES.subscribe((changed) => {
        const matching = changed.filter((sourceId) => requested.includes(sourceId));
        if (!active || !context.active || matching.length === 0) return;
        sequence += 1;
        const record = {
          sourceId: CHANGED_SOURCE_ID,
          sequence,
          value: { sourceIds: matching },
        };
        queue = queue.then(async () => {
          if (active && context.active) await listener(record);
        }).catch(() => undefined);
      });
      return context.own(async () => {
        active = false;
        unsubscribe();
        await queue;
      });
    },
  });
}

function releaseEnvelope(
  activation: ModuleActivationIdentity,
  createCorrelationId: () => SemanticCorrelationId,
): PrivateSemanticRequestEnvelope<EmptyInput> {
  return { activation, correlationId: createCorrelationId(), input: {} };
}

/** Trusted adapter for the permanent native Usage Sources provider. */
export function createUsageSourcesServiceProvider(
  options: UsageSourcesServiceProviderOptions = {},
): SemanticServiceProvider<UsageSourcesService> {
  const transport = options.transport ?? TAURI_TRANSPORT;
  const createCorrelationId = options.createCorrelationId ?? correlationId;
  return {
    service: usageSourcesService,
    bind(context) {
      context.own(() => transport.releaseActivation(
        releaseEnvelope(context.activation, createCorrelationId),
      ).then(() => undefined));
      return Object.freeze({
        inspectSource: inspectRequest(context, transport, createCorrelationId),
        refreshSources: refreshRequest(context, transport, createCorrelationId),
        observeSource: sourceChanges(context),
      });
    },
  };
}
