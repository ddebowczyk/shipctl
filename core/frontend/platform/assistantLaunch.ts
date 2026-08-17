import { invoke } from "@tauri-apps/api/core";
import {
  assistantLaunchService,
  assistantProviderId,
  assistantSessionId,
  type AssistantLaunchErrorCode,
  type AssistantLaunchGrant,
  type AssistantLaunchService,
  type AssistantModelCatalog,
  type AssistantProviderConfiguration,
  type AssistantRecoveryRecord,
  type AssistantSessionInput,
  type AssistantSessionChanged,
  type AssistantSessionObservationScope,
  type InspectAssistantModelsInput,
  type InspectAssistantProviderConfigurationInput,
  type ModuleActivationIdentity,
  type ModuleTerminalId,
  type RecordAssistantLabelInput,
  type RecordAssistantPlacementInput,
  type ResumeAssistantSessionInput,
  type SaveAssistantProviderConfigurationInput,
  type SemanticCorrelationId,
  type SemanticEventLease,
  type SemanticEventRecord,
  type SemanticResult,
  type SemanticServiceError,
  type SemanticServiceProvider,
  type SemanticServiceProviderContext,
  type StartAssistantSessionInput,
  type StartedAssistantSession,
} from "@shipctl/module-api";

import {
  createSemanticRequestAdapter,
  type PrivateSemanticRequestEnvelope,
  type PrivateSemanticRequestTransport,
} from "./semanticServiceAdapter.ts";

const COMMANDS = {
  start: "start_assistant_session",
  resume: "resume_assistant_session",
  refreshIdentity: "refresh_assistant_session_identity",
  failIdentity: "mark_assistant_session_identity_failed",
  recordPlacement: "record_assistant_session_placement",
  recordLabel: "record_assistant_session_label",
  discard: "discard_assistant_session",
  rearm: "rearm_assistant_session",
  listRestorable: "inspect_restorable_assistant_sessions",
  takeStartupWarning: "take_assistant_session_startup_warning",
  prepareForShutdown: "prepare_assistant_sessions_for_shutdown",
  inspectModels: "inspect_assistant_models",
  inspectConfiguration: "inspect_assistant_provider_configuration",
  saveConfiguration: "save_assistant_provider_configuration",
  releaseActivation: "release_assistant_launch_activation",
} as const;

type EmptyInput = Readonly<Record<never, never>>;

interface NativeAssistantRecoveryRecord {
  readonly recordId: unknown;
  readonly provider: unknown;
  readonly providerSessionId?: unknown;
  readonly launchRepoPath: unknown;
  readonly placementProjectPath: unknown;
  readonly label: unknown;
  readonly sessionMode: unknown;
  readonly model: unknown;
  readonly captureState: unknown;
  readonly restoreOnNextLaunch: unknown;
  readonly startedAt: unknown;
  readonly updatedAt: unknown;
}

interface NativeStartedAssistantSession {
  readonly terminalId: unknown;
  readonly record: NativeAssistantRecoveryRecord;
}

interface NativeProviderConfiguration {
  readonly settings: {
    readonly defaultProvider?: unknown;
    readonly defaultModel?: unknown;
    readonly defaultThinkingLevel?: unknown;
  };
  readonly configuredProviders: unknown;
}

/** Private transport seam used by the production adapter and property tests. */
export interface NativeAssistantLaunchTransport {
  startSession(
    request: PrivateSemanticRequestEnvelope<StartAssistantSessionInput>,
  ): Promise<NativeStartedAssistantSession>;
  resumeSession(
    request: PrivateSemanticRequestEnvelope<ResumeAssistantSessionInput>,
  ): Promise<NativeStartedAssistantSession>;
  refreshSessionIdentity(
    request: PrivateSemanticRequestEnvelope<AssistantSessionInput>,
  ): Promise<NativeAssistantRecoveryRecord | null>;
  markSessionIdentityFailed(
    request: PrivateSemanticRequestEnvelope<AssistantSessionInput>,
  ): Promise<NativeAssistantRecoveryRecord>;
  recordSessionPlacement(
    request: PrivateSemanticRequestEnvelope<RecordAssistantPlacementInput>,
  ): Promise<NativeAssistantRecoveryRecord>;
  recordSessionLabel(
    request: PrivateSemanticRequestEnvelope<RecordAssistantLabelInput>,
  ): Promise<NativeAssistantRecoveryRecord>;
  discardSession(
    request: PrivateSemanticRequestEnvelope<AssistantSessionInput>,
  ): Promise<void>;
  rearmSession(
    request: PrivateSemanticRequestEnvelope<AssistantSessionInput>,
  ): Promise<void>;
  inspectRestorableSessions(
    request: PrivateSemanticRequestEnvelope<EmptyInput>,
  ): Promise<readonly NativeAssistantRecoveryRecord[]>;
  takeStartupWarning(
    request: PrivateSemanticRequestEnvelope<EmptyInput>,
  ): Promise<string | null>;
  prepareForShutdown(
    request: PrivateSemanticRequestEnvelope<EmptyInput>,
  ): Promise<void>;
  inspectModels(
    request: PrivateSemanticRequestEnvelope<InspectAssistantModelsInput>,
  ): Promise<readonly string[]>;
  inspectProviderConfiguration(
    request: PrivateSemanticRequestEnvelope<InspectAssistantProviderConfigurationInput>,
  ): Promise<NativeProviderConfiguration>;
  saveProviderConfiguration(
    request: PrivateSemanticRequestEnvelope<SaveAssistantProviderConfigurationInput>,
  ): Promise<void>;
  releaseActivation(
    request: PrivateSemanticRequestEnvelope<EmptyInput>,
  ): Promise<boolean>;
}

export interface AssistantLaunchAuthorizationRequest {
  readonly activation: ModuleActivationIdentity;
  readonly grant: AssistantLaunchGrant;
  readonly provider?: string;
  readonly projectPath?: string;
  readonly recordId?: string;
}

export type AssistantLaunchAuthorizer = (
  request: AssistantLaunchAuthorizationRequest,
) => boolean;

export interface AssistantLaunchServiceProviderOptions {
  readonly transport?: NativeAssistantLaunchTransport;
  readonly authorize?: AssistantLaunchAuthorizer;
  readonly createCorrelationId?: () => SemanticCorrelationId;
}

function terminalRequest(input: StartAssistantSessionInput | ResumeAssistantSessionInput) {
  return {
    ...("provider" in input
      ? {
          provider: input.provider,
          launchRepoPath: input.launchRepoPath,
          placementProjectPath: input.placementProjectPath,
          label: input.label,
          sessionMode: input.sessionMode,
          ...(input.model === undefined ? {} : { model: input.model }),
        }
      : { recordId: input.recordId }),
    moduleSessionId: input.terminal.moduleSessionId,
    env: { ...input.terminal.environment },
    cols: input.terminal.columns,
    rows: input.terminal.rows,
    colorTheme: {
      ...input.terminal.colorTheme,
      palette: [...input.terminal.colorTheme.palette],
    },
  };
}

const TAURI_TRANSPORT: NativeAssistantLaunchTransport = {
  startSession: (request) => invoke(COMMANDS.start, {
    request: { ...request, input: terminalRequest(request.input) },
  }),
  resumeSession: (request) => invoke(COMMANDS.resume, {
    request: { ...request, input: terminalRequest(request.input) },
  }),
  refreshSessionIdentity: (request) => invoke(COMMANDS.refreshIdentity, { request }),
  markSessionIdentityFailed: (request) => invoke(COMMANDS.failIdentity, { request }),
  recordSessionPlacement: (request) => invoke(COMMANDS.recordPlacement, { request }),
  recordSessionLabel: (request) => invoke(COMMANDS.recordLabel, { request }),
  discardSession: (request) => invoke(COMMANDS.discard, { request }),
  rearmSession: (request) => invoke(COMMANDS.rearm, { request }),
  inspectRestorableSessions: (request) => invoke(COMMANDS.listRestorable, { request }),
  takeStartupWarning: (request) => invoke(COMMANDS.takeStartupWarning, { request }),
  prepareForShutdown: (request) => invoke(COMMANDS.prepareForShutdown, { request }),
  inspectModels: (request) => invoke(COMMANDS.inspectModels, { request }),
  inspectProviderConfiguration: (request) => invoke(COMMANDS.inspectConfiguration, { request }),
  saveProviderConfiguration: (request) => invoke(COMMANDS.saveConfiguration, { request }),
  releaseActivation: (request) => invoke(COMMANDS.releaseActivation, { request }),
};

const DEFAULT_AUTHORIZE: AssistantLaunchAuthorizer = ({ activation, grant }) => (
  activation.moduleId === "shipctl.assistants"
  && (grant === "assistant.launch" || grant === "assistant.session-record")
);

const REQUEST_POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

const CANCELLED_ERROR = {
  code: "assistant-launch.cancelled",
  message: "Assistant request was cancelled",
  retryable: false,
} as const;

const DISPOSED_ERROR = {
  code: "assistant-launch.activation-disposed",
  message: "The module activation is no longer active",
  retryable: false,
} as const;

class AssistantAdapterFailure extends Error {
  readonly code: AssistantLaunchErrorCode;

  constructor(code: AssistantLaunchErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function correlationId(): SemanticCorrelationId {
  return crypto.randomUUID() as SemanticCorrelationId;
}

function isAssistantLaunchErrorCode(value: unknown): value is AssistantLaunchErrorCode {
  return typeof value === "string" && [
    "assistant-launch.transport-failed",
    "assistant-launch.denied",
    "assistant-launch.invalid-request",
    "assistant-launch.invalid-response",
    "assistant-launch.unavailable",
    "assistant-launch.launch-failed",
    "assistant-launch.session-not-found",
    "assistant-launch.session-not-recoverable",
    "assistant-launch.cancelled",
    "assistant-launch.activation-disposed",
  ].includes(value);
}

function transportError(error: unknown): SemanticServiceError<AssistantLaunchErrorCode> {
  if (error instanceof AssistantAdapterFailure) {
    return { code: error.code, message: error.message, retryable: false };
  }
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && isAssistantLaunchErrorCode(error.code)
  ) {
    return {
      code: error.code,
      message: "Assistant launch request failed",
      retryable: "retryable" in error && error.retryable === true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const code: AssistantLaunchErrorCode = normalized.includes("permission")
    || normalized.includes("denied")
    || normalized.includes("not allowed")
    ? "assistant-launch.denied"
    : normalized.includes("restore record was not found")
      ? "assistant-launch.session-not-found"
      : normalized.includes("restore record is not ready")
        || normalized.includes("capture is no longer pending")
        ? "assistant-launch.session-not-recoverable"
        : normalized.includes("unsupported assistant provider")
          ? "assistant-launch.invalid-request"
          : normalized.includes("was not found on shipctl's path")
            || normalized.includes("could not start")
            ? "assistant-launch.launch-failed"
            : normalized.includes("unknown command")
              ? "assistant-launch.unavailable"
              : "assistant-launch.transport-failed";
  const publicMessage: Record<AssistantLaunchErrorCode, string> = {
    "assistant-launch.transport-failed": "Assistant launch transport failed",
    "assistant-launch.denied": "Assistant launch access was denied",
    "assistant-launch.invalid-request": "Assistant launch request was invalid",
    "assistant-launch.invalid-response": "Assistant launch response was invalid",
    "assistant-launch.unavailable": "Assistant launch is unavailable",
    "assistant-launch.launch-failed": "Assistant process could not start",
    "assistant-launch.session-not-found": "Assistant session was not found",
    "assistant-launch.session-not-recoverable": "Assistant session cannot be recovered",
    "assistant-launch.cancelled": CANCELLED_ERROR.message,
    "assistant-launch.activation-disposed": DISPOSED_ERROR.message,
  };
  return { code, message: publicMessage[code], retryable: false };
}

function failure<Output>(
  code: AssistantLaunchErrorCode,
  message: string,
): SemanticResult<Output, AssistantLaunchErrorCode> {
  return { ok: false, error: { code, message, retryable: false } };
}

function requiredText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTerminal(input: StartAssistantSessionInput["terminal"]): boolean {
  return requiredText(input.moduleSessionId)
    && Number.isSafeInteger(input.columns)
    && input.columns > 0
    && input.columns <= 65_535
    && Number.isSafeInteger(input.rows)
    && input.rows > 0
    && input.rows <= 65_535;
}

function validStart(input: StartAssistantSessionInput): boolean {
  return requiredText(input.provider)
    && requiredText(input.launchRepoPath)
    && requiredText(input.placementProjectPath)
    && requiredText(input.label)
    && (input.sessionMode === "standard" || input.sessionMode === "yolo")
    && (input.model === undefined || requiredText(input.model))
    && validTerminal(input.terminal);
}

function validProviderSettings(
  value: SaveAssistantProviderConfigurationInput["settings"],
): boolean {
  const keys = Object.keys(value);
  return keys.length === 3
    && keys.every((key) => [
      "defaultProvider",
      "defaultModel",
      "defaultThinkingLevel",
    ].includes(key))
    && [
      value.defaultProvider,
      value.defaultModel,
      value.defaultThinkingLevel,
    ].every((candidate) => candidate === null || requiredText(candidate));
}

function normalizedRecord(value: NativeAssistantRecoveryRecord): AssistantRecoveryRecord {
  if (
    !requiredText(value.recordId)
    || !requiredText(value.provider)
    || !requiredText(value.launchRepoPath)
    || !requiredText(value.placementProjectPath)
    || !requiredText(value.label)
    || (value.sessionMode !== "standard" && value.sessionMode !== "yolo")
    || (value.model !== null && !requiredText(value.model))
    || !["pending", "ready", "failed"].includes(String(value.captureState))
    || typeof value.restoreOnNextLaunch !== "boolean"
    || !Number.isSafeInteger(value.startedAt)
    || Number(value.startedAt) < 0
    || !Number.isSafeInteger(value.updatedAt)
    || Number(value.updatedAt) < 0
  ) {
    throw new AssistantAdapterFailure(
      "assistant-launch.invalid-response",
      "Native assistant recovery data was invalid",
    );
  }
  return Object.freeze({
    recordId: assistantSessionId(value.recordId),
    provider: assistantProviderId(value.provider),
    launchRepoPath: value.launchRepoPath,
    placementProjectPath: value.placementProjectPath,
    label: value.label,
    sessionMode: value.sessionMode,
    model: value.model,
    captureState: value.captureState as AssistantRecoveryRecord["captureState"],
    restoreOnNextLaunch: value.restoreOnNextLaunch,
    startedAt: value.startedAt as number,
    updatedAt: value.updatedAt as number,
  });
}

function normalizedStarted(value: NativeStartedAssistantSession): StartedAssistantSession {
  if (!requiredText(value.terminalId)) {
    throw new AssistantAdapterFailure(
      "assistant-launch.invalid-response",
      "Native assistant terminal identity was invalid",
    );
  }
  return {
    terminalId: value.terminalId as ModuleTerminalId,
    record: normalizedRecord(value.record),
  };
}

function normalizedConfiguration(
  provider: string,
  value: NativeProviderConfiguration,
): AssistantProviderConfiguration {
  const optionalText = (candidate: unknown) => candidate === undefined || candidate === null
    ? null
    : requiredText(candidate)
      ? candidate
      : undefined;
  const defaultProvider = optionalText(value.settings?.defaultProvider);
  const defaultModel = optionalText(value.settings?.defaultModel);
  const defaultThinkingLevel = optionalText(value.settings?.defaultThinkingLevel);
  if (
    defaultProvider === undefined
    || defaultModel === undefined
    || defaultThinkingLevel === undefined
    || !Array.isArray(value.configuredProviders)
    || !value.configuredProviders.every(requiredText)
  ) {
    throw new AssistantAdapterFailure(
      "assistant-launch.invalid-response",
      "Native assistant provider configuration was invalid",
    );
  }
  return Object.freeze({
    provider: assistantProviderId(provider),
    settings: Object.freeze({ defaultProvider, defaultModel, defaultThinkingLevel }),
    configuredCredentialProviders: Object.freeze([...value.configuredProviders]),
  });
}

type RuntimeChangeListener = (change: AssistantSessionChanged) => void;

class RuntimeAssistantChanges {
  readonly #listeners = new Set<RuntimeChangeListener>();

  subscribe(listener: RuntimeChangeListener): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  publish(change: AssistantSessionChanged): void {
    for (const listener of this.#listeners) listener(change);
  }
}

const RUNTIME_CHANGES = new RuntimeAssistantChanges();

function matchesScope(
  scope: AssistantSessionObservationScope,
  change: AssistantSessionChanged,
): boolean {
  return (scope.recordId === undefined || scope.recordId === change.recordId)
    && (scope.projectPath === undefined || scope.projectPath === change.projectPath);
}

function observeSessions(context: SemanticServiceProviderContext) {
  let sequence = 0;
  return Object.freeze({
    async subscribe(
      scope: AssistantSessionObservationScope,
      listener: (event: SemanticEventRecord<AssistantSessionChanged>) => void | Promise<void>,
    ): Promise<SemanticEventLease> {
      if (!context.active) throw new Error(DISPOSED_ERROR.message);
      if (scope.recordId !== undefined && !requiredText(scope.recordId)) {
        throw new Error("Assistant session observation identity is invalid");
      }
      if (scope.projectPath !== undefined && !requiredText(scope.projectPath)) {
        throw new Error("Assistant session observation project is invalid");
      }
      let active = true;
      let queue = Promise.resolve();
      const unsubscribe = RUNTIME_CHANGES.subscribe((change) => {
        if (!active || !context.active || !matchesScope(scope, change)) return;
        sequence += 1;
        const event = {
          sourceId: "shipctl.assistant-launch.sessions",
          sequence,
          value: change,
        };
        queue = queue.then(async () => {
          if (active && context.active) await listener(event);
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

function request<Input, Output>(
  context: SemanticServiceProviderContext,
  transport: PrivateSemanticRequestTransport<Input, Output, AssistantLaunchErrorCode>,
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

function releaseEnvelope(
  activation: ModuleActivationIdentity,
  createCorrelationId: () => SemanticCorrelationId,
): PrivateSemanticRequestEnvelope<EmptyInput> {
  return { activation, correlationId: createCorrelationId(), input: {} };
}

/** Trusted adapter for the permanent native Assistant Launch provider. */
export function createAssistantLaunchServiceProvider(
  options: AssistantLaunchServiceProviderOptions = {},
): SemanticServiceProvider<AssistantLaunchService> {
  const transport = options.transport ?? TAURI_TRANSPORT;
  const authorize = options.authorize ?? DEFAULT_AUTHORIZE;
  const createCorrelationId = options.createCorrelationId ?? correlationId;

  return {
    service: assistantLaunchService,
    bind(context) {
      context.own(() => transport.releaseActivation(
        releaseEnvelope(context.activation, createCorrelationId),
      ).then(() => undefined));
      const records = new Map<string, AssistantRecoveryRecord>();
      const authorized = (
        grant: AssistantLaunchGrant,
        scope: Omit<AssistantLaunchAuthorizationRequest, "activation" | "grant">,
      ) => authorize({ activation: context.activation, grant, ...scope });
      const publish = (kind: AssistantSessionChanged["kind"], record: AssistantRecoveryRecord) => {
        records.set(record.recordId, record);
        RUNTIME_CHANGES.publish({
          kind,
          recordId: record.recordId,
          projectPath: record.placementProjectPath,
          record,
        });
      };
      const sessionOperation = <Output>(
        grant: AssistantLaunchGrant,
        run: (
          envelope: PrivateSemanticRequestEnvelope<AssistantSessionInput>,
        ) => Promise<Output>,
      ) => request<AssistantSessionInput, Output>(context, {
        async request(envelope) {
          if (!requiredText(envelope.input.recordId)) {
            return failure("assistant-launch.invalid-request", "Assistant session identity is invalid");
          }
          if (!authorized(grant, { recordId: envelope.input.recordId })) {
            return failure("assistant-launch.denied", "Assistant session access was denied");
          }
          return { ok: true, value: await run(envelope) };
        },
      }, createCorrelationId);

      const service: AssistantLaunchService = Object.freeze({
        startSession: request<StartAssistantSessionInput, StartedAssistantSession>(context, {
          async request(envelope) {
            const input = envelope.input;
            if (!validStart(input)) {
              return failure("assistant-launch.invalid-request", "Assistant start request is invalid");
            }
            if (!authorized("assistant.launch", {
              provider: input.provider,
              projectPath: input.placementProjectPath,
            })) {
              return failure("assistant-launch.denied", "Assistant launch was denied");
            }
            const started = normalizedStarted(await transport.startSession(envelope));
            if (started.record.provider !== input.provider) {
              return failure("assistant-launch.invalid-response", "Assistant provider identity changed during launch");
            }
            publish("started", started.record);
            return { ok: true, value: started };
          },
        }, createCorrelationId),
        resumeSession: request<ResumeAssistantSessionInput, StartedAssistantSession>(context, {
          async request(envelope) {
            if (!requiredText(envelope.input.recordId) || !validTerminal(envelope.input.terminal)) {
              return failure("assistant-launch.invalid-request", "Assistant resume request is invalid");
            }
            if (!authorized("assistant.launch", { recordId: envelope.input.recordId })) {
              return failure("assistant-launch.denied", "Assistant resume was denied");
            }
            const started = normalizedStarted(await transport.resumeSession(envelope));
            if (started.record.recordId !== envelope.input.recordId) {
              return failure("assistant-launch.invalid-response", "Assistant session identity changed during resume");
            }
            publish("resumed", started.record);
            return { ok: true, value: started };
          },
        }, createCorrelationId),
        refreshSessionIdentity: sessionOperation("assistant.session-record", async (envelope) => {
          const value = await transport.refreshSessionIdentity(envelope);
          const record = value === null ? null : normalizedRecord(value);
          if (record !== null) publish("identity-updated", record);
          return record;
        }),
        markSessionIdentityFailed: sessionOperation("assistant.session-record", async (envelope) => {
          const record = normalizedRecord(await transport.markSessionIdentityFailed(envelope));
          publish("identity-failed", record);
          return record;
        }),
        recordSessionPlacement: request<RecordAssistantPlacementInput, AssistantRecoveryRecord>(context, {
          async request(envelope) {
            if (!requiredText(envelope.input.recordId)
              || !requiredText(envelope.input.placementProjectPath)) {
              return failure("assistant-launch.invalid-request", "Assistant placement is invalid");
            }
            if (!authorized("assistant.session-record", {
              recordId: envelope.input.recordId,
              projectPath: envelope.input.placementProjectPath,
            })) {
              return failure("assistant-launch.denied", "Assistant placement access was denied");
            }
            const record = normalizedRecord(await transport.recordSessionPlacement(envelope));
            publish("placement-recorded", record);
            return { ok: true, value: record };
          },
        }, createCorrelationId),
        recordSessionLabel: request<RecordAssistantLabelInput, AssistantRecoveryRecord>(context, {
          async request(envelope) {
            if (!requiredText(envelope.input.recordId) || !requiredText(envelope.input.label)) {
              return failure("assistant-launch.invalid-request", "Assistant session label is invalid");
            }
            if (!authorized("assistant.session-record", { recordId: envelope.input.recordId })) {
              return failure("assistant-launch.denied", "Assistant session access was denied");
            }
            const record = normalizedRecord(await transport.recordSessionLabel(envelope));
            publish("label-recorded", record);
            return { ok: true, value: record };
          },
        }, createCorrelationId),
        discardSession: sessionOperation("assistant.session-record", async (envelope) => {
          await transport.discardSession(envelope);
          const record = records.get(envelope.input.recordId);
          records.delete(envelope.input.recordId);
          if (record) {
            RUNTIME_CHANGES.publish({
              kind: "discarded",
              recordId: record.recordId,
              projectPath: record.placementProjectPath,
              record: null,
            });
          }
        }),
        rearmSession: sessionOperation("assistant.session-record", async (envelope) => {
          await transport.rearmSession(envelope);
          const previous = records.get(envelope.input.recordId);
          if (previous) publish("rearmed", { ...previous, restoreOnNextLaunch: true });
        }),
        inspectRestorableSessions: request<EmptyInput, readonly AssistantRecoveryRecord[]>(context, {
          async request(envelope) {
            if (!authorized("assistant.session-record", {})) {
              return failure("assistant-launch.denied", "Assistant recovery access was denied");
            }
            const result = (await transport.inspectRestorableSessions(envelope)).map(normalizedRecord);
            records.clear();
            for (const record of result) records.set(record.recordId, record);
            return { ok: true, value: result };
          },
        }, createCorrelationId),
        takeStartupWarning: request<EmptyInput, string | null>(context, {
          async request(envelope) {
            if (!authorized("assistant.session-record", {})) {
              return failure("assistant-launch.denied", "Assistant recovery access was denied");
            }
            return { ok: true, value: await transport.takeStartupWarning(envelope) };
          },
        }, createCorrelationId),
        prepareForShutdown: request<EmptyInput, void>(context, {
          async request(envelope) {
            if (!authorized("assistant.session-record", {})) {
              return failure("assistant-launch.denied", "Assistant recovery access was denied");
            }
            await transport.prepareForShutdown(envelope);
            return { ok: true, value: undefined };
          },
        }, createCorrelationId),
        inspectModels: request<InspectAssistantModelsInput, AssistantModelCatalog>(context, {
          async request(envelope): Promise<SemanticResult<AssistantModelCatalog, AssistantLaunchErrorCode>> {
            if (!requiredText(envelope.input.provider)) {
              return failure("assistant-launch.invalid-request", "Assistant provider is invalid");
            }
            if (!authorized("assistant.launch", { provider: envelope.input.provider })) {
              return failure("assistant-launch.denied", "Assistant model access was denied");
            }
            const models = await transport.inspectModels(envelope);
            if (!Array.isArray(models) || !models.every(requiredText)) {
              return failure("assistant-launch.invalid-response", "Assistant model catalog was invalid");
            }
            return {
              ok: true,
              value: { provider: envelope.input.provider, models: [...new Set(models)] },
            };
          },
        }, createCorrelationId),
        inspectProviderConfiguration: request<
          InspectAssistantProviderConfigurationInput,
          AssistantProviderConfiguration
        >(context, {
          async request(envelope) {
            if (!requiredText(envelope.input.provider)) {
              return failure("assistant-launch.invalid-request", "Assistant provider is invalid");
            }
            if (!authorized("assistant.session-record", { provider: envelope.input.provider })) {
              return failure("assistant-launch.denied", "Assistant configuration access was denied");
            }
            const config = normalizedConfiguration(
              envelope.input.provider,
              await transport.inspectProviderConfiguration(envelope),
            );
            return { ok: true, value: config };
          },
        }, createCorrelationId),
        saveProviderConfiguration: request<SaveAssistantProviderConfigurationInput, void>(context, {
          async request(envelope) {
            if (!requiredText(envelope.input.provider)
              || !validProviderSettings(envelope.input.settings)) {
              return failure("assistant-launch.invalid-request", "Assistant provider configuration is invalid");
            }
            if (!authorized("assistant.session-record", { provider: envelope.input.provider })) {
              return failure("assistant-launch.denied", "Assistant configuration access was denied");
            }
            await transport.saveProviderConfiguration(envelope);
            return { ok: true, value: undefined };
          },
        }, createCorrelationId),
        observeSessions: observeSessions(context),
      });
      return service;
    },
  };
}
