import { invoke } from "@tauri-apps/api/core";
import {
  processesService,
  type CommandInspection,
  type InspectCommandInput,
  type InspectListeningProcessesInput,
  type ListeningProcessInspection,
  type ModuleActivationIdentity,
  type ProcessesErrorCode,
  type ProcessesService,
  type SemanticCorrelationId,
  type SemanticResult,
  type SemanticServiceError,
  type SemanticServiceProvider,
  type SemanticServiceProviderContext,
  type TerminateInspectedProcessInput,
  type TerminatedProcess,
} from "@shipctl/module-api";

import {
  createSemanticRequestAdapter,
  type PrivateSemanticRequestEnvelope,
  type PrivateSemanticRequestTransport,
} from "./semanticServiceAdapter.ts";

const INSPECT_LISTENING_PROCESSES_COMMAND = "inspect_listening_processes";
const TERMINATE_INSPECTED_PROCESS_COMMAND = "terminate_inspected_process";
const INSPECT_PROCESS_COMMAND_COMMAND = "inspect_process_command";
const RELEASE_PROCESS_INSPECTIONS_COMMAND = "release_process_inspections";

type EmptyInput = Readonly<Record<never, never>>;

/** Private transport seam used by the production adapter and property tests. */
export interface NativeProcessesTransport {
  inspectListeningProcesses(
    request: PrivateSemanticRequestEnvelope<InspectListeningProcessesInput>,
  ): Promise<readonly ListeningProcessInspection[]>;
  terminateInspectedProcess(
    request: PrivateSemanticRequestEnvelope<TerminateInspectedProcessInput>,
  ): Promise<TerminatedProcess>;
  inspectCommand(
    request: PrivateSemanticRequestEnvelope<InspectCommandInput>,
  ): Promise<CommandInspection>;
  releaseProcessInspections(
    request: PrivateSemanticRequestEnvelope<EmptyInput>,
  ): Promise<number>;
}

export interface ProcessesServiceProviderOptions {
  readonly transport?: NativeProcessesTransport;
  readonly createCorrelationId?: () => SemanticCorrelationId;
}

const TAURI_PROCESSES_TRANSPORT: NativeProcessesTransport = {
  inspectListeningProcesses: (request) =>
    invoke(INSPECT_LISTENING_PROCESSES_COMMAND, { request }),
  terminateInspectedProcess: (request) =>
    invoke(TERMINATE_INSPECTED_PROCESS_COMMAND, { request }),
  inspectCommand: (request) => invoke(INSPECT_PROCESS_COMMAND_COMMAND, { request }),
  releaseProcessInspections: (request) =>
    invoke(RELEASE_PROCESS_INSPECTIONS_COMMAND, { request }),
};

const REQUEST_POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

const CANCELLED_ERROR = {
  code: "processes.cancelled",
  message: "Process request was cancelled",
  retryable: false,
} as const;

const DISPOSED_ERROR = {
  code: "processes.activation-disposed",
  message: "The module activation is no longer active",
  retryable: false,
} as const;

function correlationId(): SemanticCorrelationId {
  return crypto.randomUUID() as SemanticCorrelationId;
}

function isProcessesErrorCode(value: unknown): value is ProcessesErrorCode {
  return typeof value === "string" && [
    "processes.transport-failed",
    "processes.denied",
    "processes.stale-inspection",
    "processes.cancelled",
    "processes.activation-disposed",
    "processes.invalid-request",
  ].includes(value);
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return error instanceof Error ? error.message : String(error);
}

function transportError(error: unknown): SemanticServiceError<ProcessesErrorCode> {
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && isProcessesErrorCode(error.code)
  ) {
    return {
      code: error.code,
      message: errorMessage(error),
      retryable: "retryable" in error && error.retryable === true,
    };
  }
  const message = errorMessage(error);
  const normalized = message.toLowerCase();
  const denied = normalized.includes("permission")
    || normalized.includes("denied")
    || normalized.includes("not permitted")
    || normalized.includes("not allowed");
  return {
    code: denied ? "processes.denied" : "processes.transport-failed",
    message,
    retryable: false,
  };
}

function successfulTransport<Input, Output>(
  operation: (request: PrivateSemanticRequestEnvelope<Input>) => Promise<Output>,
): PrivateSemanticRequestTransport<Input, Output, ProcessesErrorCode> {
  return {
    async request(envelope): Promise<SemanticResult<Output, ProcessesErrorCode>> {
      return { ok: true, value: await operation(envelope) };
    },
  };
}

function request<Input, Output>(
  context: SemanticServiceProviderContext,
  transport: PrivateSemanticRequestTransport<Input, Output, ProcessesErrorCode>,
  createCorrelationId?: () => SemanticCorrelationId,
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
  return {
    activation,
    correlationId: createCorrelationId(),
    input: {},
  };
}

/** Trusted adapter for the permanent native Processes provider. */
export function createProcessesServiceProvider(
  options: ProcessesServiceProviderOptions = {},
): SemanticServiceProvider<ProcessesService> {
  const transport = options.transport ?? TAURI_PROCESSES_TRANSPORT;
  const createCorrelationId = options.createCorrelationId ?? correlationId;

  return {
    service: processesService,
    bind(context) {
      context.own(() => transport.releaseProcessInspections(
        releaseEnvelope(context.activation, createCorrelationId),
      ).then(() => undefined));

      return Object.freeze({
        inspectListeningPorts: request(
          context,
          successfulTransport(transport.inspectListeningProcesses),
          createCorrelationId,
        ),
        terminateInspectedProcess: request(
          context,
          successfulTransport(transport.terminateInspectedProcess),
          createCorrelationId,
        ),
        inspectCommand: request(
          context,
          successfulTransport(transport.inspectCommand),
          createCorrelationId,
        ),
      });
    },
  };
}
