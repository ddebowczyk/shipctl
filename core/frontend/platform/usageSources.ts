import { invoke } from "@tauri-apps/api/core";
import {
  usageSourcesService,
  type InspectUsageSourceInput,
  type ModuleActivationIdentity,
  type ProviderUsageSnapshot,
  type RefreshUsageSourcesInput,
  type SemanticEventLease,
  type SemanticEventRecord,
  type SemanticServiceError,
  type SemanticServiceProvider,
  type SemanticServiceProviderContext,
  type UsageOverview,
  type UsageProvider,
  type UsageSourceDescriptor,
  type UsageSourceInspection,
  type UsageSourceObservationScope,
  type UsageSourceRefreshReceipt,
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
import type { HostMessageFrame } from "./runtimeMessages.ts";

const COMMANDS = {
  inspectSnapshots: "plugin:shipctl-usage|get_all_usage_snapshots",
  inspectOverview: "plugin:shipctl-usage|get_usage_overview",
  refreshSources: "plugin:shipctl-usage|refresh_usage_data",
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

const USAGE_WINDOWS = ["5h", "7d", "30d", "365d"] as const;

const DESCRIPTORS: readonly UsageSourceDescriptor[] = Object.freeze([
  { sourceId: "claude", kinds: ["provider-quota", "local-transcript"], authority: "host-managed" },
  { sourceId: "codex", kinds: ["provider-quota", "local-transcript"], authority: "host-managed" },
  { sourceId: "antigravity", kinds: ["provider-quota", "local-transcript"], authority: "host-managed" },
  { sourceId: "gemini", kinds: ["provider-quota", "local-transcript"], authority: "host-managed" },
  { sourceId: "opencode", kinds: ["local-transcript"], authority: "host-managed" },
  { sourceId: "pi", kinds: ["local-transcript"], authority: "host-managed" },
]);

interface RawUsageSourcesChanged {
  readonly sourceIds: readonly string[];
}

type RuntimeChangeListener = (event: RawUsageSourcesChanged) => void;

class RuntimeUsageSourceChangeTransport {
  readonly #listeners = new Set<RuntimeChangeListener>();

  subscribe(listener: RuntimeChangeListener): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  publish(sourceIds: readonly UsageProvider[]): void {
    for (const listener of this.#listeners) listener({ sourceIds });
  }
}

const RUNTIME_CHANGES = new RuntimeUsageSourceChangeTransport();

export interface LegacyUsageSourcesTransport {
  inspectSnapshots(
    request: PrivateSemanticRequestEnvelope<{ readonly kind: "source-snapshots" }>,
  ): Promise<readonly ProviderUsageSnapshot[]>;
  inspectOverview(
    request: PrivateSemanticRequestEnvelope<{
      readonly kind: "legacy-overview-projection";
      readonly window: UsageOverview["window"];
    }>,
  ): Promise<UsageOverview>;
  refreshSources(
    request: PrivateSemanticRequestEnvelope<RefreshUsageSourcesInput>,
  ): Promise<void>;
  subscribeChanges(
    activation: ModuleActivationIdentity,
    listener: (event: RawUsageSourcesChanged) => void,
  ): Promise<() => void | Promise<void>>;
}

export interface UsageSourcesAuthorizationRequest {
  readonly activation: ModuleActivationIdentity;
  readonly grant: UsageSourcesGrant;
  readonly sourceIds: readonly UsageProvider[];
}

export type UsageSourcesAuthorizer = (
  request: UsageSourcesAuthorizationRequest,
) => boolean;

export interface UsageSourcesServiceProviderOptions {
  readonly transport?: LegacyUsageSourcesTransport;
  readonly authorize?: UsageSourcesAuthorizer;
}

const TAURI_TRANSPORT: LegacyUsageSourcesTransport = {
  inspectSnapshots: () => invoke(COMMANDS.inspectSnapshots),
  inspectOverview: ({ input }) => invoke(COMMANDS.inspectOverview, { window: input.window }),
  refreshSources: () => invoke(COMMANDS.refreshSources),
  subscribeChanges: async (_activation, listener) => RUNTIME_CHANGES.subscribe(listener),
};

/** Adapts the current native completion topic to the semantic event source. */
export function observeUsageSourceMessageFrame(frame: HostMessageFrame): void {
  if (frame.kind === "broadcast" && frame.endpoint === "usage.ingest-completed") {
    RUNTIME_CHANGES.publish(USAGE_PROVIDERS);
  }
}

/** Transitional code grant table. Phase D moves this check to native admission. */
const DEFAULT_AUTHORIZE: UsageSourcesAuthorizer = ({ activation }) => (
  activation.moduleId === "shipctl.usage"
);

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

function transportError(error: unknown): SemanticServiceError<UsageSourcesErrorCode> {
  const normalized = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const code: UsageSourcesErrorCode = normalized.includes("permission")
    || normalized.includes("denied")
    || normalized.includes("not allowed")
    ? "usage-sources.denied"
    : normalized.includes("not found") || normalized.includes("unknown command")
      ? "usage-sources.unavailable"
      : "usage-sources.transport-failed";
  return {
    code,
    message: code === "usage-sources.denied"
      ? "Usage source access was denied"
      : code === "usage-sources.unavailable"
        ? "Usage sources are unavailable"
        : "Usage source access failed",
    retryable: false,
  };
}

function request<Input, Output>(
  context: SemanticServiceProviderContext,
  transport: PrivateSemanticRequestTransport<Input, Output, UsageSourcesErrorCode>,
) {
  return createSemanticRequestAdapter({
    activation: context.activation,
    active: () => context.active,
    policy: REQUEST_POLICY,
    transport,
    transportError,
    cancelledError: CANCELLED_ERROR,
    disposedError: DISPOSED_ERROR,
  });
}

function failure(code: UsageSourcesErrorCode, message: string) {
  return { ok: false, error: { code, message, retryable: false } } as const;
}

function isProvider(value: string): value is UsageProvider {
  return (USAGE_PROVIDERS as readonly string[]).includes(value);
}

function isUsageWindow(value: unknown): value is UsageOverview["window"] {
  return typeof value === "string"
    && (USAGE_WINDOWS as readonly string[]).includes(value);
}

function sourceIds(
  input: RefreshUsageSourcesInput | UsageSourceObservationScope,
): readonly UsageProvider[] | null {
  const ids = input.sourceIds ?? USAGE_PROVIDERS;
  return ids.length > 0 && ids.every(isProvider) ? [...new Set(ids)] : null;
}

function redactSnapshot(snapshot: ProviderUsageSnapshot): ProviderUsageSnapshot {
  return {
    ...snapshot,
    error: snapshot.error === null ? null : "Usage source is unavailable",
  };
}

function authorizeRequest(
  context: SemanticServiceProviderContext,
  authorize: UsageSourcesAuthorizer,
  grant: UsageSourcesGrant,
  ids: readonly UsageProvider[],
) {
  return authorize({ activation: context.activation, grant, sourceIds: ids })
    ? null
    : failure("usage-sources.denied", "Usage source access was denied");
}

function createSourceChanges(
  context: SemanticServiceProviderContext,
  transport: LegacyUsageSourcesTransport,
  authorize: UsageSourcesAuthorizer,
) {
  let sequence = 0;
  return Object.freeze({
    async subscribe(
      scope: UsageSourceObservationScope,
      listener: (event: SemanticEventRecord<UsageSourcesChanged>) => void | Promise<void>,
    ): Promise<SemanticEventLease> {
      if (!context.active) throw new Error(DISPOSED_ERROR.message);
      const requested = sourceIds(scope);
      if (requested === null) throw new Error("Usage source scope is invalid");
      if (!authorize({
        activation: context.activation,
        grant: "usage-source.observe",
        sourceIds: requested,
      })) {
        throw new Error("Usage source access was denied");
      }
      let active = true;
      let queue = Promise.resolve();
      const unlisten = await transport.subscribeChanges(context.activation, (event) => {
        const matching = event.sourceIds.filter(isProvider).filter((id) => requested.includes(id));
        if (!active || matching.length === 0) return;
        sequence += 1;
        const record = {
          sourceId: CHANGED_SOURCE_ID,
          sequence,
          value: { sourceIds: matching },
        };
        queue = queue
          .then(async () => {
            if (active && context.active) await listener(record);
          })
          .catch(() => undefined);
      });
      if (!context.active) {
        active = false;
        await unlisten();
        throw new Error(DISPOSED_ERROR.message);
      }
      return context.own(async () => {
        active = false;
        await unlisten();
        await queue;
      });
    },
  });
}

/** Trusted adapter for the current Usage plugin commands and completion event. */
export function createUsageSourcesServiceProvider(
  options: UsageSourcesServiceProviderOptions = {},
): SemanticServiceProvider<UsageSourcesService> {
  const transport = options.transport ?? TAURI_TRANSPORT;
  const authorize = options.authorize ?? DEFAULT_AUTHORIZE;
  return {
    service: usageSourcesService,
    bind(context) {
      return Object.freeze({
        inspectSource: request<InspectUsageSourceInput, UsageSourceInspection>(context, {
          async request(envelope) {
            const denied = authorizeRequest(
              context,
              authorize,
              "usage-source.read",
              USAGE_PROVIDERS,
            );
            if (denied) return denied;
            if (envelope.input.kind === "source-snapshots") {
              const snapshots = await transport.inspectSnapshots({
                ...envelope,
                input: envelope.input,
              });
              if (!snapshots.every((snapshot) => isProvider(snapshot.provider))) {
                throw new Error("Usage source transport returned an invalid provider");
              }
              return {
                ok: true,
                value: {
                  kind: "source-snapshots",
                  sources: DESCRIPTORS,
                  snapshots: snapshots.map(redactSnapshot),
                },
              };
            }
            if (
              envelope.input.kind !== "legacy-overview-projection"
              || !isUsageWindow(envelope.input.window)
            ) {
              return failure("usage-sources.invalid-request", "Usage source request is invalid");
            }
            const overview = await transport.inspectOverview({
              ...envelope,
              input: envelope.input,
            });
            return {
              ok: true,
              value: { kind: "legacy-overview-projection", overview },
            };
          },
        }),
        refreshSources: request<RefreshUsageSourcesInput, UsageSourceRefreshReceipt>(context, {
          async request(envelope) {
            const requested = sourceIds(envelope.input);
            if (requested === null) {
              return failure("usage-sources.invalid-request", "Usage source identity is invalid");
            }
            const denied = authorizeRequest(
              context,
              authorize,
              "usage-source.refresh",
              requested,
            );
            if (denied) return denied;
            await transport.refreshSources(envelope);
            return { ok: true, value: { acceptedSourceIds: requested } };
          },
        }),
        observeSource: createSourceChanges(context, transport, authorize),
      });
    },
  };
}
