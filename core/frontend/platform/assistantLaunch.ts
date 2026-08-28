import { invoke } from "@tauri-apps/api/core";
import {
  ASSISTANT_LAUNCH_GRANTS,
  assistantLaunchService,
  assistantProviderId,
  assistantSessionId,
  type AssistantLaunchErrorCode,
  type AssistantLaunchGrant,
  type AssistantLaunchService,
  type AssistantProcessArgument,
  type AssistantProcessLaunch,
  type AssistantRecoveryRecord,
  type AssistantResourceExecuteInput,
  type AssistantResourceExecuteResult,
  type AssistantResourceReadInput,
  type AssistantResourceReadResult,
  type AssistantResourceWriteInput,
  type AssistantSessionChanged,
  type AssistantSessionInput,
  type AssistantSessionObservationScope,
  type ModuleActivationIdentity,
  type ModuleTerminalId,
  type RecordAssistantLabelInput,
  type RecordAssistantPlacementInput,
  type RecordAssistantSessionIdentityInput,
  type ResumeAssistantSessionInput,
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
  recordIdentity: "record_assistant_session_identity",
  failIdentity: "mark_assistant_session_identity_failed",
  recordPlacement: "record_assistant_session_placement",
  recordLabel: "record_assistant_session_label",
  discard: "discard_assistant_session",
  rearm: "rearm_assistant_session",
  listRestorable: "inspect_restorable_assistant_sessions",
  takeStartupWarning: "take_assistant_session_startup_warning",
  prepareForShutdown: "prepare_assistant_sessions_for_shutdown",
  readResource: "read_assistant_launch_resource",
  writeResource: "write_assistant_launch_resource",
  executeResource: "execute_assistant_launch_resource",
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

/** The private request format carries only grants accepted at admission. */
export interface NativeAssistantLaunchRequest<Input> {
  readonly activation: {
    readonly moduleId: string;
    readonly activationId: string;
    readonly effectiveGrants: readonly AssistantLaunchGrant[];
  };
  readonly correlationId: SemanticCorrelationId;
  readonly input: Input;
}

/** Private transport seam used by the production adapter and property tests. */
export interface NativeAssistantLaunchTransport {
  startSession(
    request: NativeAssistantLaunchRequest<StartAssistantSessionInput>,
  ): Promise<NativeStartedAssistantSession>;
  resumeSession(
    request: NativeAssistantLaunchRequest<ResumeAssistantSessionInput>,
  ): Promise<NativeStartedAssistantSession>;
  recordSessionIdentity(
    request: NativeAssistantLaunchRequest<RecordAssistantSessionIdentityInput>,
  ): Promise<NativeAssistantRecoveryRecord>;
  markSessionIdentityFailed(
    request: NativeAssistantLaunchRequest<AssistantSessionInput>,
  ): Promise<NativeAssistantRecoveryRecord>;
  recordSessionPlacement(
    request: NativeAssistantLaunchRequest<RecordAssistantPlacementInput>,
  ): Promise<NativeAssistantRecoveryRecord>;
  recordSessionLabel(
    request: NativeAssistantLaunchRequest<RecordAssistantLabelInput>,
  ): Promise<NativeAssistantRecoveryRecord>;
  discardSession(
    request: NativeAssistantLaunchRequest<AssistantSessionInput>,
  ): Promise<void>;
  rearmSession(
    request: NativeAssistantLaunchRequest<AssistantSessionInput>,
  ): Promise<void>;
  inspectRestorableSessions(
    request: NativeAssistantLaunchRequest<EmptyInput>,
  ): Promise<readonly NativeAssistantRecoveryRecord[]>;
  takeStartupWarning(
    request: NativeAssistantLaunchRequest<EmptyInput>,
  ): Promise<string | null>;
  prepareForShutdown(
    request: NativeAssistantLaunchRequest<EmptyInput>,
  ): Promise<void>;
  readResource(
    request: NativeAssistantLaunchRequest<AssistantResourceReadInput>,
  ): Promise<unknown>;
  writeResource(
    request: NativeAssistantLaunchRequest<AssistantResourceWriteInput>,
  ): Promise<void>;
  executeResource(
    request: NativeAssistantLaunchRequest<AssistantResourceExecuteInput>,
  ): Promise<unknown>;
  releaseActivation(
    request: NativeAssistantLaunchRequest<EmptyInput>,
  ): Promise<boolean>;
}

export interface AssistantLaunchAuthorizationRequest {
  readonly activation: ModuleActivationIdentity;
  readonly grant: AssistantLaunchGrant;
  readonly provider?: string;
  readonly projectPath?: string;
  readonly recordId?: string;
}

/** Test seam only; production authorization is always admission-derived. */
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
          launch: input.launch,
          ...(input.initialSessionIdentity === undefined
            ? {}
            : { initialSessionIdentity: input.initialSessionIdentity }),
        }
      : { recordId: input.recordId, launch: input.launch }),
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
  recordSessionIdentity: (request) => invoke(COMMANDS.recordIdentity, { request }),
  markSessionIdentityFailed: (request) => invoke(COMMANDS.failIdentity, { request }),
  recordSessionPlacement: (request) => invoke(COMMANDS.recordPlacement, { request }),
  recordSessionLabel: (request) => invoke(COMMANDS.recordLabel, { request }),
  discardSession: (request) => invoke(COMMANDS.discard, { request }),
  rearmSession: (request) => invoke(COMMANDS.rearm, { request }),
  inspectRestorableSessions: (request) => invoke(COMMANDS.listRestorable, { request }),
  takeStartupWarning: (request) => invoke(COMMANDS.takeStartupWarning, { request }),
  prepareForShutdown: (request) => invoke(COMMANDS.prepareForShutdown, { request }),
  readResource: (request) => invoke(COMMANDS.readResource, { request }),
  writeResource: (request) => invoke(COMMANDS.writeResource, { request }),
  executeResource: (request) => invoke(COMMANDS.executeResource, { request }),
  releaseActivation: (request) => invoke(COMMANDS.releaseActivation, { request }),
};

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
      message: "message" in error && requiredText(error.message)
        ? error.message
        : "Assistant launch request failed",
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
        : normalized.includes("could not start")
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

function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null ? value as Readonly<Record<string, unknown>> : null;
}

function requiredText(value: unknown, maximum = 4_096): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validProgram(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
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

function validProcessArgument(value: unknown, allowCapturedIdentity: boolean): value is AssistantProcessArgument {
  if (requiredText(value)) return true;
  const candidate = object(value);
  return allowCapturedIdentity
    && candidate !== null
    && candidate.kind === "captured-session-id"
    && Object.keys(candidate).length === 1;
}

function validLaunch(
  launch: AssistantProcessLaunch,
  requireCapturedIdentity: boolean,
): boolean {
  return validProgram(launch.program)
    && Array.isArray(launch.arguments)
    && launch.arguments.length <= 128
    && launch.arguments.every((argument) => validProcessArgument(argument, requireCapturedIdentity))
    && (!requireCapturedIdentity || launch.arguments.some(
      (argument) => object(argument)?.kind === "captured-session-id",
    ));
}

function validStart(input: StartAssistantSessionInput): boolean {
  return requiredText(input.provider, 128)
    && requiredText(input.launchRepoPath)
    && requiredText(input.placementProjectPath)
    && requiredText(input.label, 256)
    && requiredText(input.sessionMode, 128)
    && (input.model === undefined || requiredText(input.model, 256))
    && (input.initialSessionIdentity === undefined || requiredText(input.initialSessionIdentity, 512))
    && validLaunch(input.launch, false)
    && validTerminal(input.terminal);
}

function safeRelativePath(value: unknown): value is string {
  return requiredText(value)
    && !value.startsWith("/")
    && !value.split(/[\\/]+/).some((part) => part === "." || part === "..");
}

function validResourceRead(input: AssistantResourceReadInput): boolean {
  const request = input.request;
  if (!requiredText(request.resourceId, 128) || !safeRelativePath(request.relativePath)) return false;
  if (request.kind === "file") {
    return (request.maxBytes === undefined || (
      Number.isSafeInteger(request.maxBytes) && request.maxBytes > 0
    )) && (request.firstLineOnly === undefined || typeof request.firstLineOnly === "boolean");
  }
  return request.kind === "tree"
    && (request.maxFiles === undefined || (Number.isSafeInteger(request.maxFiles) && request.maxFiles > 0))
    && (request.maxBytesPerFile === undefined
      || (Number.isSafeInteger(request.maxBytesPerFile) && request.maxBytesPerFile > 0))
    && (request.extensions === undefined
      || (Array.isArray(request.extensions)
        && request.extensions.every((extension) => /^[A-Za-z0-9]{1,32}$/.test(extension))))
    && (request.metadataOnly === undefined || typeof request.metadataOnly === "boolean");
}

function validResourceWrite(input: AssistantResourceWriteInput): boolean {
  return requiredText(input.resourceId, 128)
    && safeRelativePath(input.relativePath)
    && typeof input.content === "string"
    && input.content.length <= 4 * 1024 * 1024;
}

function validResourceCompletion(value: unknown): boolean {
  if (value === undefined) return true;
  const completion = object(value);
  if (completion === null || completion.kind !== "jsonl-response-id"
    || Object.keys(completion).length !== 2) return false;
  return (typeof completion.id === "string" && requiredText(completion.id, 256))
    || (typeof completion.id === "number" && Number.isSafeInteger(completion.id));
}

function validResourceExecute(input: AssistantResourceExecuteInput): boolean {
  return requiredText(input.resourceId, 128)
    && validProgram(input.program)
    && Array.isArray(input.arguments)
    && input.arguments.length <= 128
    && input.arguments.every((argument) => typeof argument === "string"
      && argument.length <= 4_096
      && !/[\u0000-\u001f\u007f]/.test(argument))
    && (input.stdin === undefined || (typeof input.stdin === "string" && input.stdin.length <= 1024 * 1024))
    && (input.timeoutMs === undefined || (Number.isSafeInteger(input.timeoutMs) && input.timeoutMs > 0))
    && (input.maxOutputBytes === undefined
      || (Number.isSafeInteger(input.maxOutputBytes) && input.maxOutputBytes > 0))
    && validResourceCompletion(input.completion);
}

function normalizedRecord(value: NativeAssistantRecoveryRecord): AssistantRecoveryRecord {
  if (
    !requiredText(value.recordId)
    || !requiredText(value.provider, 128)
    || !requiredText(value.launchRepoPath)
    || !requiredText(value.placementProjectPath)
    || !requiredText(value.label, 256)
    || !requiredText(value.sessionMode, 128)
    || (value.model !== null && !requiredText(value.model, 256))
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

function normalizedReadResult(
  input: AssistantResourceReadInput,
  value: unknown,
): AssistantResourceReadResult {
  const result = object(value);
  if (result === null || result.kind !== input.request.kind || result.resourceId !== input.request.resourceId) {
    throw new AssistantAdapterFailure("assistant-launch.invalid-response", "Native assistant resource data was invalid");
  }
  if (result.kind === "file" && typeof result.content === "string") {
    return Object.freeze({ kind: "file", resourceId: result.resourceId, content: result.content });
  }
  if (result.kind === "tree" && Array.isArray(result.files)) {
    const files = result.files.map((file) => object(file)).filter((file): file is Readonly<Record<string, unknown>> => file !== null);
    if (files.length !== result.files.length
      || !files.every((file) => safeRelativePath(file.relativePath) && typeof file.content === "string")) {
      throw new AssistantAdapterFailure("assistant-launch.invalid-response", "Native assistant resource tree was invalid");
    }
    return Object.freeze({
      kind: "tree",
      resourceId: result.resourceId,
      files: Object.freeze(files.map((file) => Object.freeze({
        relativePath: file.relativePath as string,
        content: file.content as string,
      }))),
    });
  }
  throw new AssistantAdapterFailure("assistant-launch.invalid-response", "Native assistant resource data was invalid");
}

function normalizedExecuteResult(
  input: AssistantResourceExecuteInput,
  value: unknown,
): AssistantResourceExecuteResult {
  const result = object(value);
  if (result === null
    || result.resourceId !== input.resourceId
    || typeof result.stdout !== "string"
    || typeof result.stderr !== "string"
    || !Number.isSafeInteger(result.status)) {
    throw new AssistantAdapterFailure("assistant-launch.invalid-response", "Native assistant command result was invalid");
  }
  return Object.freeze({
    resourceId: result.resourceId,
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status as number,
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

function observeSessions(
  context: SemanticServiceProviderContext,
  canObserve: () => boolean,
) {
  let sequence = 0;
  return Object.freeze({
    async subscribe(
      scope: AssistantSessionObservationScope,
      listener: (event: SemanticEventRecord<AssistantSessionChanged>) => void | Promise<void>,
    ): Promise<SemanticEventLease> {
      if (!context.active) throw new Error(DISPOSED_ERROR.message);
      if (!canObserve()) throw new Error("Assistant session access was denied");
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
        const event = { sourceId: "shipctl.assistant-launch.sessions", sequence, value: change };
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

function isAssistantLaunchGrant(value: string): value is AssistantLaunchGrant {
  return Object.values(ASSISTANT_LAUNCH_GRANTS).includes(value as AssistantLaunchGrant);
}

function nativeRequest<Input>(
  context: SemanticServiceProviderContext,
  envelope: PrivateSemanticRequestEnvelope<Input>,
): NativeAssistantLaunchRequest<Input> {
  const admission = context.acceptedAdmission;
  return {
    activation: {
      moduleId: context.activation.moduleId,
      activationId: context.activation.activationId,
      effectiveGrants: admission === null
        ? []
        : admission.effectiveGrants.filter(isAssistantLaunchGrant),
    },
    correlationId: envelope.correlationId,
    input: envelope.input,
  };
}

function admissionAllows(
  context: SemanticServiceProviderContext,
  grant: AssistantLaunchGrant,
): boolean {
  const admission = context.acceptedAdmission;
  return admission !== null
    && admission.artifact.moduleId === context.activation.moduleId
    && admission.effectiveGrants.includes(grant);
}

/** Trusted adapter for the permanent native Assistant Launch provider. */
export function createAssistantLaunchServiceProvider(
  options: AssistantLaunchServiceProviderOptions = {},
): SemanticServiceProvider<AssistantLaunchService> {
  const transport = options.transport ?? TAURI_TRANSPORT;
  const createCorrelationId = options.createCorrelationId ?? correlationId;

  return {
    service: assistantLaunchService,
    bind(context) {
      context.own(() => transport.releaseActivation(nativeRequest(context, {
        activation: context.activation,
        correlationId: createCorrelationId(),
        input: {},
      })).then(() => undefined));
      const records = new Map<string, AssistantRecoveryRecord>();
      const authorized = (
        grant: AssistantLaunchGrant,
        scope: Omit<AssistantLaunchAuthorizationRequest, "activation" | "grant">,
      ) => (options.authorize ?? ((request) => admissionAllows(context, request.grant)))({
        activation: context.activation,
        grant,
        ...scope,
      });
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
        run: (envelope: PrivateSemanticRequestEnvelope<AssistantSessionInput>) => Promise<Output>,
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

      return Object.freeze({
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
            const started = normalizedStarted(await transport.startSession(nativeRequest(context, envelope)));
            if (started.record.provider !== input.provider) {
              return failure("assistant-launch.invalid-response", "Assistant provider identity changed during launch");
            }
            publish("started", started.record);
            return { ok: true, value: started };
          },
        }, createCorrelationId),
        resumeSession: request<ResumeAssistantSessionInput, StartedAssistantSession>(context, {
          async request(envelope) {
            if (!requiredText(envelope.input.recordId)
              || !validLaunch(envelope.input.launch, true)
              || !validTerminal(envelope.input.terminal)) {
              return failure("assistant-launch.invalid-request", "Assistant resume request is invalid");
            }
            if (!authorized("assistant.launch", { recordId: envelope.input.recordId })) {
              return failure("assistant-launch.denied", "Assistant resume was denied");
            }
            const started = normalizedStarted(await transport.resumeSession(nativeRequest(context, envelope)));
            if (started.record.recordId !== envelope.input.recordId) {
              return failure("assistant-launch.invalid-response", "Assistant session identity changed during resume");
            }
            publish("resumed", started.record);
            return { ok: true, value: started };
          },
        }, createCorrelationId),
        recordSessionIdentity: request<
          RecordAssistantSessionIdentityInput,
          AssistantRecoveryRecord
        >(context, {
          async request(envelope) {
            if (!requiredText(envelope.input.recordId) || !requiredText(envelope.input.providerSessionId, 512)) {
              return failure("assistant-launch.invalid-request", "Assistant session identity is invalid");
            }
            if (!authorized("assistant.session-record", { recordId: envelope.input.recordId })) {
              return failure("assistant-launch.denied", "Assistant session access was denied");
            }
            const record = normalizedRecord(await transport.recordSessionIdentity(nativeRequest(context, envelope)));
            publish("identity-updated", record);
            return { ok: true, value: record };
          },
        }, createCorrelationId),
        markSessionIdentityFailed: sessionOperation("assistant.session-record", async (envelope) => {
          const record = normalizedRecord(await transport.markSessionIdentityFailed(nativeRequest(context, envelope)));
          publish("identity-failed", record);
          return record;
        }),
        recordSessionPlacement: request<RecordAssistantPlacementInput, AssistantRecoveryRecord>(context, {
          async request(envelope) {
            if (!requiredText(envelope.input.recordId) || !requiredText(envelope.input.placementProjectPath)) {
              return failure("assistant-launch.invalid-request", "Assistant placement is invalid");
            }
            if (!authorized("assistant.session-record", {
              recordId: envelope.input.recordId,
              projectPath: envelope.input.placementProjectPath,
            })) {
              return failure("assistant-launch.denied", "Assistant placement access was denied");
            }
            const record = normalizedRecord(await transport.recordSessionPlacement(nativeRequest(context, envelope)));
            publish("placement-recorded", record);
            return { ok: true, value: record };
          },
        }, createCorrelationId),
        recordSessionLabel: request<RecordAssistantLabelInput, AssistantRecoveryRecord>(context, {
          async request(envelope) {
            if (!requiredText(envelope.input.recordId) || !requiredText(envelope.input.label, 256)) {
              return failure("assistant-launch.invalid-request", "Assistant session label is invalid");
            }
            if (!authorized("assistant.session-record", { recordId: envelope.input.recordId })) {
              return failure("assistant-launch.denied", "Assistant session access was denied");
            }
            const record = normalizedRecord(await transport.recordSessionLabel(nativeRequest(context, envelope)));
            publish("label-recorded", record);
            return { ok: true, value: record };
          },
        }, createCorrelationId),
        discardSession: sessionOperation("assistant.session-record", async (envelope) => {
          await transport.discardSession(nativeRequest(context, envelope));
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
          await transport.rearmSession(nativeRequest(context, envelope));
          const previous = records.get(envelope.input.recordId);
          if (previous) publish("rearmed", { ...previous, restoreOnNextLaunch: true });
        }),
        inspectRestorableSessions: request<EmptyInput, readonly AssistantRecoveryRecord[]>(context, {
          async request(envelope) {
            if (!authorized("assistant.session-record", {})) {
              return failure("assistant-launch.denied", "Assistant recovery access was denied");
            }
            const result = (await transport.inspectRestorableSessions(nativeRequest(context, envelope)))
              .map(normalizedRecord);
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
            const warning = await transport.takeStartupWarning(nativeRequest(context, envelope));
            if (warning !== null && !requiredText(warning)) {
              return failure("assistant-launch.invalid-response", "Assistant startup warning was invalid");
            }
            return { ok: true, value: warning };
          },
        }, createCorrelationId),
        prepareForShutdown: request<EmptyInput, void>(context, {
          async request(envelope) {
            if (!authorized("assistant.session-record", {})) {
              return failure("assistant-launch.denied", "Assistant recovery access was denied");
            }
            await transport.prepareForShutdown(nativeRequest(context, envelope));
            return { ok: true, value: undefined };
          },
        }, createCorrelationId),
        readResource: request<AssistantResourceReadInput, AssistantResourceReadResult>(context, {
          async request(envelope) {
            if (!validResourceRead(envelope.input)) {
              return failure("assistant-launch.invalid-request", "Assistant resource read is invalid");
            }
            if (!authorized("assistant.resource.read", {})) {
              return failure("assistant-launch.denied", "Assistant resource read was denied");
            }
            return {
              ok: true,
              value: normalizedReadResult(
                envelope.input,
                await transport.readResource(nativeRequest(context, envelope)),
              ),
            };
          },
        }, createCorrelationId),
        writeResource: request<AssistantResourceWriteInput, void>(context, {
          async request(envelope) {
            if (!validResourceWrite(envelope.input)) {
              return failure("assistant-launch.invalid-request", "Assistant resource write is invalid");
            }
            if (!authorized("assistant.resource.write", {})) {
              return failure("assistant-launch.denied", "Assistant resource write was denied");
            }
            await transport.writeResource(nativeRequest(context, envelope));
            return { ok: true, value: undefined };
          },
        }, createCorrelationId),
        executeResource: request<AssistantResourceExecuteInput, AssistantResourceExecuteResult>(context, {
          async request(envelope) {
            if (!validResourceExecute(envelope.input)) {
              return failure("assistant-launch.invalid-request", "Assistant resource command is invalid");
            }
            if (!authorized("assistant.resource.execute", {})) {
              return failure("assistant-launch.denied", "Assistant resource command was denied");
            }
            return {
              ok: true,
              value: normalizedExecuteResult(
                envelope.input,
                await transport.executeResource(nativeRequest(context, envelope)),
              ),
            };
          },
        }, createCorrelationId),
        observeSessions: observeSessions(
          context,
          () => authorized("assistant.session-record", {}),
        ),
      } satisfies AssistantLaunchService);
    },
  };
}
