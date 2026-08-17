import {
  processesService,
  type ListeningProcessInspection,
  type ProcessesErrorCode,
  type ProcessesService,
  type ProcessInspectionId,
} from "../protocol/processes";
import type {
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

export type FakeProcessesOperation =
  | "inspect-listening-ports"
  | "terminate-inspected-process"
  | "inspect-command";

export interface FakeProcessesTrace {
  readonly operation: FakeProcessesOperation;
  readonly request: FakeRequestTrace<unknown>;
}

export interface FakeProcessesProviderOptions {
  readonly inspections?: () => readonly ListeningProcessInspection[];
  readonly availableCommands?: readonly string[];
  readonly deniedOperations?: readonly FakeProcessesOperation[];
  readonly trace?: FakeProcessesTrace[];
}

class FakeProcessesFailure extends Error {
  readonly code: ProcessesErrorCode;

  constructor(code: ProcessesErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

const CANCELLED = {
  code: "processes.cancelled",
  message: "Process request was cancelled",
  retryable: false,
} as const;

const DISPOSED = {
  code: "processes.activation-disposed",
  message: "The module activation is no longer active",
  retryable: false,
} as const;

function failedError(error: unknown): SemanticServiceError<ProcessesErrorCode> {
  if (error instanceof FakeProcessesFailure) {
    return { code: error.code, message: error.message, retryable: false };
  }
  return {
    code: "processes.transport-failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

function operation<Input, Output>(
  context: SemanticServiceProviderContext,
  name: FakeProcessesOperation,
  options: FakeProcessesProviderOptions,
  handle: (input: Input) => Output | Promise<Output>,
) {
  const traces: FakeRequestTrace<Input>[] = [];
  const request = createFakeRequestOperation({
    context,
    policy: POLICY,
    handle: ({ input }) => {
      if (options.deniedOperations?.includes(name)) {
        throw new FakeProcessesFailure(
          "processes.denied",
          `Fake process operation denied: ${name}`,
        );
      }
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
      if (captured) options.trace?.push({ operation: name, request: captured });
      return outcome;
    },
  });
}

/** Test-only process provider with no DOM, Tauri, or native dependency. */
export function createFakeProcessesServiceProvider(
  options: FakeProcessesProviderOptions = {},
): SemanticServiceProvider<ProcessesService> {
  return {
    service: processesService,
    bind(context) {
      const current = new Map<ProcessInspectionId, ListeningProcessInspection>();
      const availableCommands = new Set(options.availableCommands ?? []);
      const service = Object.freeze({
        inspectListeningPorts: operation(
          context,
          "inspect-listening-ports",
          options,
          () => {
            const inspections = [...(options.inspections?.() ?? [])];
            current.clear();
            for (const inspection of inspections) {
              current.set(inspection.inspectionId, inspection);
            }
            return inspections;
          },
        ),
        terminateInspectedProcess: operation(
          context,
          "terminate-inspected-process",
          options,
          ({ inspectionId }) => {
            const inspection = current.get(inspectionId);
            if (!inspection) {
              throw new FakeProcessesFailure(
                "processes.stale-inspection",
                "The process inspection is no longer current",
              );
            }
            for (const [id, candidate] of current) {
              if (candidate.processId === inspection.processId) current.delete(id);
            }
            return { inspectionId };
          },
        ),
        inspectCommand: operation(
          context,
          "inspect-command",
          options,
          ({ command }) => {
            const normalized = command.trim();
            if (normalized.length === 0) {
              throw new FakeProcessesFailure(
                "processes.invalid-request",
                "Command cannot be empty",
              );
            }
            return {
              command: normalized,
              available: availableCommands.has(normalized),
            };
          },
        ),
      });
      context.own(() => current.clear());
      return service;
    },
  };
}
