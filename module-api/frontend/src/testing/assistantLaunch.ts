import {
  assistantLaunchService,
  assistantProviderId,
  assistantSessionId,
  type AssistantLaunchErrorCode,
  type AssistantLaunchGrant,
  type AssistantLaunchService,
  type AssistantProviderConfiguration,
  type AssistantRecoveryRecord,
  type AssistantSessionChanged,
  type AssistantSessionId,
  type AssistantSessionObservationScope,
  type ModuleTerminalId,
  type SaveAssistantProviderConfigurationInput,
} from "../protocol/assistantLaunch";
import type {
  SemanticEventLease,
  SemanticEventRecord,
  SemanticServiceError,
} from "../protocol/semanticServices";
import type {
  SemanticServiceProvider,
  SemanticServiceProviderContext,
} from "../host/semanticServices";

import {
  createFakeRequestOperation,
  type FakeRequestTrace,
} from "./semanticServices";

export type FakeAssistantLaunchOperation =
  | "start-session"
  | "resume-session"
  | "refresh-session-identity"
  | "mark-session-identity-failed"
  | "record-session-placement"
  | "record-session-label"
  | "discard-session"
  | "rearm-session"
  | "inspect-restorable-sessions"
  | "take-startup-warning"
  | "prepare-for-shutdown"
  | "inspect-models"
  | "inspect-provider-configuration"
  | "save-provider-configuration";

export interface FakeAssistantLaunchTrace {
  readonly operation: FakeAssistantLaunchOperation;
  readonly grant: AssistantLaunchGrant;
  readonly request: FakeRequestTrace<unknown>;
}

export interface FakeAssistantLaunchProviderOptions {
  readonly records?: readonly AssistantRecoveryRecord[];
  readonly models?: Readonly<Record<string, readonly string[]>>;
  readonly configurations?: Readonly<Record<string, AssistantProviderConfiguration>>;
  readonly startupWarning?: string | null;
  readonly deniedGrants?: readonly AssistantLaunchGrant[];
  readonly captureReady?: boolean;
  readonly trace?: FakeAssistantLaunchTrace[];
  readonly changes?: FakeAssistantSessionChangeController;
}

class FakeAssistantLaunchFailure extends Error {
  readonly code: AssistantLaunchErrorCode;

  constructor(code: AssistantLaunchErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

const CANCELLED = {
  code: "assistant-launch.cancelled",
  message: "Assistant request was cancelled",
  retryable: false,
} as const;

const DISPOSED = {
  code: "assistant-launch.activation-disposed",
  message: "The module activation is no longer active",
  retryable: false,
} as const;

let nextFakeSession = 1;

function failedError(error: unknown): SemanticServiceError<AssistantLaunchErrorCode> {
  if (error instanceof FakeAssistantLaunchFailure) {
    return { code: error.code, message: error.message, retryable: false };
  }
  return {
    code: "assistant-launch.transport-failed",
    message: "The fake Assistant Launch provider failed",
    retryable: false,
  };
}

function requireGrant(
  options: FakeAssistantLaunchProviderOptions,
  grant: AssistantLaunchGrant,
): void {
  if (options.deniedGrants?.includes(grant)) {
    throw new FakeAssistantLaunchFailure(
      "assistant-launch.denied",
      `Fake Assistant Launch grant denied: ${grant}`,
    );
  }
}

function requiredText(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new FakeAssistantLaunchFailure(
      "assistant-launch.invalid-request",
      "Assistant request text cannot be empty",
    );
  }
  return normalized;
}

function operation<Input, Output>(
  context: SemanticServiceProviderContext,
  name: FakeAssistantLaunchOperation,
  grant: AssistantLaunchGrant,
  options: FakeAssistantLaunchProviderOptions,
  handle: (input: Input) => Output | Promise<Output>,
) {
  const traces: FakeRequestTrace<Input>[] = [];
  const request = createFakeRequestOperation({
    context,
    policy: POLICY,
    handle: ({ input }) => {
      requireGrant(options, grant);
      return handle(input);
    },
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
          grant,
          request: captured as FakeRequestTrace<unknown>,
        });
      }
      return outcome;
    },
  });
}

interface FakeAssistantSubscription {
  readonly context: SemanticServiceProviderContext;
  readonly scope: AssistantSessionObservationScope;
  readonly listener: (
    event: SemanticEventRecord<AssistantSessionChanged>,
  ) => void | Promise<void>;
  readonly dispose: () => Promise<void>;
  active: boolean;
  sequence: number;
  queue: Promise<void>;
}

function matchesScope(
  scope: AssistantSessionObservationScope,
  change: AssistantSessionChanged,
): boolean {
  return (scope.recordId === undefined || scope.recordId === change.recordId)
    && (scope.projectPath === undefined || scope.projectPath === change.projectPath);
}

/** Drives fake assistant lifecycle events across activation-scoped leases. */
export class FakeAssistantSessionChangeController {
  readonly #subscriptions = new Set<FakeAssistantSubscription>();

  subscribe(
    context: SemanticServiceProviderContext,
    scope: AssistantSessionObservationScope,
    listener: FakeAssistantSubscription["listener"],
  ): SemanticEventLease {
    let subscription: FakeAssistantSubscription;
    const owned = context.own(async () => {
      subscription.active = false;
      this.#subscriptions.delete(subscription);
      await subscription.queue;
    });
    subscription = {
      context,
      scope,
      listener,
      active: true,
      sequence: 0,
      queue: Promise.resolve(),
      dispose: () => owned.dispose(),
    };
    this.#subscriptions.add(subscription);
    return Object.freeze({
      id: owned.id,
      activation: owned.activation,
      get disposed() { return owned.disposed; },
      dispose: subscription.dispose,
    });
  }

  async publish(change: AssistantSessionChanged): Promise<void> {
    const settlements: Promise<void>[] = [];
    for (const subscription of this.#subscriptions) {
      if (!subscription.active
        || !subscription.context.active
        || !matchesScope(subscription.scope, change)) continue;
      subscription.sequence += 1;
      const event = {
        sourceId: "shipctl.assistant-launch.sessions",
        sequence: subscription.sequence,
        value: change,
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

function cloneRecord(record: AssistantRecoveryRecord): AssistantRecoveryRecord {
  return Object.freeze({ ...record });
}

function sessionRecord(
  input: Parameters<AssistantLaunchService["startSession"]["execute"]>[0],
): AssistantRecoveryRecord {
  const now = nextFakeSession;
  const recordId = assistantSessionId(`fake-assistant-${nextFakeSession++}`);
  return Object.freeze({
    recordId,
    provider: input.provider,
    launchRepoPath: requiredText(input.launchRepoPath),
    placementProjectPath: requiredText(input.placementProjectPath),
    label: requiredText(input.label),
    sessionMode: input.sessionMode,
    model: input.model ?? null,
    captureState: "pending",
    restoreOnNextLaunch: false,
    startedAt: now,
    updatedAt: now,
  });
}

/** Tauri-free provider for Assistant launch and recovery workflows. */
export function createFakeAssistantLaunchServiceProvider(
  options: FakeAssistantLaunchProviderOptions = {},
): SemanticServiceProvider<AssistantLaunchService> {
  return {
    service: assistantLaunchService,
    bind(context) {
      const records = new Map<AssistantSessionId, AssistantRecoveryRecord>(
        (options.records ?? []).map((record) => [record.recordId, cloneRecord(record)]),
      );
      const models = new Map(Object.entries(options.models ?? {}));
      const configurations = new Map(
        Object.entries(options.configurations ?? {}).map(([provider, config]) => [
          provider,
          Object.freeze({
            ...config,
            settings: Object.freeze({ ...config.settings }),
            configuredCredentialProviders: Object.freeze([
              ...config.configuredCredentialProviders,
            ]),
          }),
        ]),
      );
      const changes = options.changes ?? new FakeAssistantSessionChangeController();
      let startupWarning = options.startupWarning ?? null;

      const requireRecord = (recordId: AssistantSessionId) => {
        const record = records.get(recordId);
        if (!record) {
          throw new FakeAssistantLaunchFailure(
            "assistant-launch.session-not-found",
            "Assistant session was not found",
          );
        }
        return record;
      };
      const changed = async (
        kind: AssistantSessionChanged["kind"],
        record: AssistantRecoveryRecord,
      ) => {
        records.set(record.recordId, record);
        await changes.publish({
          kind,
          recordId: record.recordId,
          projectPath: record.placementProjectPath,
          record,
        });
      };

      return Object.freeze({
        startSession: operation(context, "start-session", "assistant.launch", options, async (input) => {
          requiredText(input.terminal.moduleSessionId);
          const record = sessionRecord(input);
          await changed("started", record);
          return {
            terminalId: `fake-terminal-${record.recordId}` as ModuleTerminalId,
            record,
          };
        }),
        resumeSession: operation(context, "resume-session", "assistant.launch", options, async (input) => {
          requiredText(input.terminal.moduleSessionId);
          const current = requireRecord(input.recordId);
          if (current.captureState !== "ready" || !current.restoreOnNextLaunch) {
            throw new FakeAssistantLaunchFailure(
              "assistant-launch.session-not-recoverable",
              "Assistant session is not ready for recovery",
            );
          }
          const record = Object.freeze({
            ...current,
            restoreOnNextLaunch: false,
            updatedAt: current.updatedAt + 1,
          });
          await changed("resumed", record);
          return {
            terminalId: `fake-terminal-${record.recordId}` as ModuleTerminalId,
            record,
          };
        }),
        refreshSessionIdentity: operation(
          context,
          "refresh-session-identity",
          "assistant.session-record",
          options,
          async ({ recordId }) => {
            const current = requireRecord(recordId);
            if (current.captureState !== "pending") return current;
            if (options.captureReady === false) return null;
            const record = Object.freeze({
              ...current,
              captureState: "ready" as const,
              updatedAt: current.updatedAt + 1,
            });
            await changed("identity-updated", record);
            return record;
          },
        ),
        markSessionIdentityFailed: operation(
          context,
          "mark-session-identity-failed",
          "assistant.session-record",
          options,
          async ({ recordId }) => {
            const current = requireRecord(recordId);
            const record = Object.freeze({
              ...current,
              captureState: "failed" as const,
              updatedAt: current.updatedAt + 1,
            });
            await changed("identity-failed", record);
            return record;
          },
        ),
        recordSessionPlacement: operation(
          context,
          "record-session-placement",
          "assistant.session-record",
          options,
          async ({ recordId, placementProjectPath }) => {
            const current = requireRecord(recordId);
            const record = Object.freeze({
              ...current,
              placementProjectPath: requiredText(placementProjectPath),
              updatedAt: current.updatedAt + 1,
            });
            await changed("placement-recorded", record);
            return record;
          },
        ),
        recordSessionLabel: operation(
          context,
          "record-session-label",
          "assistant.session-record",
          options,
          async ({ recordId, label }) => {
            const current = requireRecord(recordId);
            const record = Object.freeze({
              ...current,
              label: requiredText(label),
              updatedAt: current.updatedAt + 1,
            });
            await changed("label-recorded", record);
            return record;
          },
        ),
        discardSession: operation(
          context,
          "discard-session",
          "assistant.session-record",
          options,
          async ({ recordId }) => {
            const record = requireRecord(recordId);
            records.delete(recordId);
            await changes.publish({
              kind: "discarded",
              recordId,
              projectPath: record.placementProjectPath,
              record: null,
            });
          },
        ),
        rearmSession: operation(
          context,
          "rearm-session",
          "assistant.session-record",
          options,
          async ({ recordId }) => {
            const current = requireRecord(recordId);
            if (current.captureState !== "ready") {
              throw new FakeAssistantLaunchFailure(
                "assistant-launch.session-not-recoverable",
                "Assistant session is not ready for recovery",
              );
            }
            await changed("rearmed", Object.freeze({
              ...current,
              restoreOnNextLaunch: true,
              updatedAt: current.updatedAt + 1,
            }));
          },
        ),
        inspectRestorableSessions: operation(
          context,
          "inspect-restorable-sessions",
          "assistant.session-record",
          options,
          () => [...records.values()].filter(
            (record) => record.captureState === "ready" && record.restoreOnNextLaunch,
          ),
        ),
        takeStartupWarning: operation(
          context,
          "take-startup-warning",
          "assistant.session-record",
          options,
          () => {
            const warning = startupWarning;
            startupWarning = null;
            return warning;
          },
        ),
        prepareForShutdown: operation(
          context,
          "prepare-for-shutdown",
          "assistant.session-record",
          options,
          () => {
            for (const [recordId, current] of records) {
              if (current.captureState !== "ready") {
                records.delete(recordId);
              } else {
                records.set(recordId, Object.freeze({
                  ...current,
                  restoreOnNextLaunch: true,
                  updatedAt: current.updatedAt + 1,
                }));
              }
            }
          },
        ),
        inspectModels: operation(
          context,
          "inspect-models",
          "assistant.launch",
          options,
          ({ provider }) => ({ provider, models: [...(models.get(provider) ?? [])] }),
        ),
        inspectProviderConfiguration: operation(
          context,
          "inspect-provider-configuration",
          "assistant.session-record",
          options,
          ({ provider }) => configurations.get(provider) ?? {
            provider,
            settings: {
              defaultProvider: null,
              defaultModel: null,
              defaultThinkingLevel: null,
            },
            configuredCredentialProviders: [],
          },
        ),
        saveProviderConfiguration: operation(
          context,
          "save-provider-configuration",
          "assistant.session-record",
          options,
          (input: SaveAssistantProviderConfigurationInput) => {
            const previous = configurations.get(input.provider);
            configurations.set(input.provider, Object.freeze({
              provider: input.provider,
              settings: Object.freeze({ ...input.settings }),
              configuredCredentialProviders: Object.freeze([
                ...(previous?.configuredCredentialProviders ?? []),
              ]),
            }));
          },
        ),
        observeSessions: Object.freeze({
          async subscribe(
            scope: AssistantSessionObservationScope,
            listener: FakeAssistantSubscription["listener"],
          ) {
            requireGrant(options, "assistant.session-record");
            if (!context.active) throw new Error(DISPOSED.message);
            return changes.subscribe(context, scope, listener);
          },
        }),
      });
    },
  };
}
