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
  type UsageSourceDataset,
  type UsageSourceId,
  type UsageSourceInspection,
  type UsageSourceObservationScope,
  type UsageSourceRecord,
  type UsageSourceRefreshReceipt,
  type UsageSourceResourceReadInput,
  type UsageSourceResourceResult,
  type UsageSourcesChanged,
  type UsageSourcesErrorCode,
  type UsageSourcesGrant,
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
  readResource: "read_usage_source_resource",
  release: "release_usage_sources_activation",
} as const;

const CHANGED_SOURCE_ID = "shipctl.usage-sources.changed";
const MAX_SOURCE_IDS = 64;

const USAGE_SOURCE_GRANTS = new Set<UsageSourcesGrant>([
  "usage-source.read",
  "usage-source.refresh",
  "usage-source.observe",
]);

type EmptyInput = Readonly<Record<never, never>>;

/**
 * Private framing adds admission-derived grants before the native command sees
 * a request. The permanent host has no source registry or product allowlist.
 */
export interface NativeUsageSourcesRequest<Input> {
  readonly activation: {
    readonly moduleId: string;
    readonly activationId: string;
    readonly effectiveGrants: readonly UsageSourcesGrant[];
  };
  readonly correlationId: SemanticCorrelationId;
  readonly input: Input;
}

/** Private transport seam used by the production adapter and property tests. */
export interface NativeUsageSourcesTransport {
  inspectSources(
    request: NativeUsageSourcesRequest<InspectUsageSourceInput>,
  ): Promise<UsageSourceDataset>;
  refreshSources(
    request: NativeUsageSourcesRequest<RefreshUsageSourcesInput>,
  ): Promise<UsageSourceRefreshReceipt>;
  readResource(
    request: NativeUsageSourcesRequest<UsageSourceResourceReadInput>,
  ): Promise<UsageSourceResourceResult>;
  releaseActivation(
    request: NativeUsageSourcesRequest<EmptyInput>,
  ): Promise<boolean>;
}

export interface UsageSourcesServiceProviderOptions {
  readonly transport?: NativeUsageSourcesTransport;
  readonly createCorrelationId?: () => SemanticCorrelationId;
}

const TAURI_TRANSPORT: NativeUsageSourcesTransport = {
  inspectSources: (request) => invoke(COMMANDS.inspect, { request }),
  refreshSources: (request) => invoke(COMMANDS.refresh, { request }),
  readResource: (request) => invoke(COMMANDS.readResource, { request }),
  releaseActivation: (request) => invoke(COMMANDS.release, { request }),
};

type RuntimeChangeListener = (sourceIds: readonly UsageSourceId[]) => void;

class RuntimeUsageSourceChanges {
  readonly #listeners = new Set<RuntimeChangeListener>();

  subscribe(listener: RuntimeChangeListener): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  publish(sourceIds: readonly UsageSourceId[]): void {
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

function validSourceId(value: unknown): value is UsageSourceId {
  return typeof value === "string"
    && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

function normalizedSourceIds(value: unknown): readonly UsageSourceId[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SOURCE_IDS) return null;
  if (!value.every(validSourceId)) return null;
  const ids = [...new Set(value)];
  return ids.length === value.length ? ids : null;
}

function isUsageSourcesGrant(value: string): value is UsageSourcesGrant {
  return USAGE_SOURCE_GRANTS.has(value as UsageSourcesGrant);
}

function authorize(
  context: SemanticServiceProviderContext,
  grant: UsageSourcesGrant,
): SemanticResult<never, UsageSourcesErrorCode> | null {
  const admission = context.acceptedAdmission;
  return admission !== null
    && admission.artifact.moduleId === context.activation.moduleId
    && admission.effectiveGrants.includes(grant)
    ? null
    : invalidRequest("Usage source access was denied", "usage-sources.denied");
}

function nativeRequest<Input>(
  context: SemanticServiceProviderContext,
  envelope: PrivateSemanticRequestEnvelope<Input>,
): NativeUsageSourcesRequest<Input> {
  const admission = context.acceptedAdmission;
  return {
    activation: {
      moduleId: context.activation.moduleId,
      activationId: context.activation.activationId,
      effectiveGrants: admission === null
        ? []
        : admission.effectiveGrants.filter(isUsageSourcesGrant),
    },
    correlationId: envelope.correlationId,
    input: envelope.input,
  };
}

function invalidRequest<Output>(
  message: string,
  code: UsageSourcesErrorCode = "usage-sources.invalid-request",
): SemanticResult<Output, UsageSourcesErrorCode> {
  return { ok: false, error: { code, message, retryable: false } };
}

function validRecordScope(
  dataset: UsageSourceDataset,
  sourceIds: readonly UsageSourceId[],
): boolean {
  return dataset.records.every(({ sourceId }) => sourceIds.includes(sourceId));
}

function validRefreshInput(input: RefreshUsageSourcesInput): boolean {
  const sourceIds = normalizedSourceIds(input.sourceIds);
  if (sourceIds === null || input.updates === undefined) return sourceIds !== null;
  if (!Array.isArray(input.updates) || input.updates.length !== sourceIds.length) return false;
  const updateIds = input.updates.map(({ sourceId }) => sourceId);
  if (normalizedSourceIds(updateIds) === null || updateIds.some((sourceId) => !sourceIds.includes(sourceId))) {
    return false;
  }
  return input.updates.every((update) => (
    validSourceId(update.sourceId)
    && Array.isArray(update.records)
    && update.records.every((record: UsageSourceRecord) => record.sourceId === update.sourceId)
  ));
}

function validResourceInput(input: UsageSourceResourceReadInput): boolean {
  if (!validSourceId(input.sourceId) || typeof input.request !== "object" || input.request === null) {
    return false;
  }
  const request = input.request as { readonly kind?: unknown; readonly resourceId?: unknown };
  return typeof request.kind === "string"
    && typeof request.resourceId === "string"
    && request.resourceId.length > 0
    && request.resourceId.length <= 128;
}

function validResourceResult(
  input: UsageSourceResourceReadInput,
  result: UsageSourceResourceResult,
): boolean {
  return result.kind === input.request.kind && result.resourceId === input.request.resourceId;
}

function inspectRequest(
  context: SemanticServiceProviderContext,
  transport: NativeUsageSourcesTransport,
  createCorrelationId: () => SemanticCorrelationId,
) {
  return request<InspectUsageSourceInput, UsageSourceInspection>(context, {
    async request(envelope) {
      const denied = authorize(context, "usage-source.read");
      if (denied) return denied;
      if (envelope.input.kind !== "source-dataset") {
        return invalidRequest("Usage source request is invalid");
      }
      const sourceIds = normalizedSourceIds(envelope.input.sourceIds);
      if (sourceIds === null) return invalidRequest("Usage source identity is invalid");
      const dataset = await transport.inspectSources(nativeRequest(context, {
        ...envelope,
        input: { kind: "source-dataset", sourceIds },
      }));
      if (!validRecordScope(dataset, sourceIds)) {
        return invalidRequest("Native usage source response exceeded its requested scope");
      }
      return { ok: true, value: { kind: "source-dataset", dataset } };
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
      const denied = authorize(context, "usage-source.refresh");
      if (denied) return denied;
      if (!validRefreshInput(envelope.input)) {
        return invalidRequest("Usage source refresh input is invalid");
      }
      const sourceIds = normalizedSourceIds(envelope.input.sourceIds);
      if (sourceIds === null) return invalidRequest("Usage source identity is invalid");
      const receipt = await transport.refreshSources(nativeRequest(context, {
        ...envelope,
        input: { ...envelope.input, sourceIds },
      }));
      if (
        receipt.acceptedSourceIds.length !== sourceIds.length
        || receipt.acceptedSourceIds.some((sourceId) => !sourceIds.includes(sourceId))
      ) {
        return invalidRequest("Native usage source receipt did not match its request");
      }
      RUNTIME_CHANGES.publish(receipt.acceptedSourceIds);
      return { ok: true, value: receipt };
    },
  }, createCorrelationId);
}

function readResourceRequest(
  context: SemanticServiceProviderContext,
  transport: NativeUsageSourcesTransport,
  createCorrelationId: () => SemanticCorrelationId,
) {
  return request<UsageSourceResourceReadInput, UsageSourceResourceResult>(context, {
    async request(envelope) {
      const denied = authorize(context, "usage-source.read");
      if (denied) return denied;
      if (!validResourceInput(envelope.input)) {
        return invalidRequest("Usage source resource request is invalid");
      }
      const result = await transport.readResource(nativeRequest(context, envelope));
      return validResourceResult(envelope.input, result)
        ? { ok: true, value: result }
        : invalidRequest("Native usage source resource response is invalid");
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
      if (authorize(context, "usage-source.observe")) {
        throw new Error("Usage source observation was denied");
      }
      const sourceIds = normalizedSourceIds(scope.sourceIds);
      if (sourceIds === null) throw new Error("Usage source scope is invalid");
      let active = true;
      let queue = Promise.resolve();
      const unsubscribe = RUNTIME_CHANGES.subscribe((changed) => {
        const matching = changed.filter((sourceId) => sourceIds.includes(sourceId));
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
  context: SemanticServiceProviderContext,
  createCorrelationId: () => SemanticCorrelationId,
): NativeUsageSourcesRequest<EmptyInput> {
  return nativeRequest(context, {
    activation: context.activation as ModuleActivationIdentity,
    correlationId: createCorrelationId(),
    input: {},
  });
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
        releaseEnvelope(context, createCorrelationId),
      ).then(() => undefined));
      return Object.freeze({
        inspectSource: inspectRequest(context, transport, createCorrelationId),
        refreshSources: refreshRequest(context, transport, createCorrelationId),
        readResource: readResourceRequest(context, transport, createCorrelationId),
        observeSource: sourceChanges(context),
      });
    },
  };
}
