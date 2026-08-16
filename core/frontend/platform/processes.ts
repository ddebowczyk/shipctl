import { invoke } from "@tauri-apps/api/core";
import {
  processesService,
  type CommandInspection,
  type ListeningProcessInspection,
  type ProcessesErrorCode,
  type ProcessesService,
  type ProcessInspectionId,
  type InspectCommandInput,
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

const LIST_LISTENING_PORTS_COMMAND = "plugin:shipctl-ports|list_listening_ports";
const KILL_PORT_COMMAND = "plugin:shipctl-ports|kill_port";
const CHECK_COMMAND_EXISTS_COMMAND = "check_command_exists";

export interface LegacyPortInfo {
  readonly port: number;
  readonly pid: number;
  readonly process: string;
  readonly cwd: string;
  readonly project: string;
  readonly framework: string;
  readonly uptime: string;
  readonly memoryKb: number;
}

/** Private transport seam used by the production adapter and differential tests. */
export interface LegacyProcessesTransport {
  listListeningPorts(
    request: PrivateSemanticRequestEnvelope<Readonly<Record<never, never>>>,
  ): Promise<readonly LegacyPortInfo[]>;
  terminateProcess(
    processId: number,
    request: PrivateSemanticRequestEnvelope<TerminateInspectedProcessInput>,
  ): Promise<void>;
  inspectCommand(
    command: string,
    request: PrivateSemanticRequestEnvelope<InspectCommandInput>,
  ): Promise<boolean>;
}

export interface ProcessesServiceProviderOptions {
  readonly transport?: LegacyProcessesTransport;
  readonly createInspectionId?: () => ProcessInspectionId;
}

const TAURI_PROCESSES_TRANSPORT: LegacyProcessesTransport = {
  listListeningPorts: () => invoke(LIST_LISTENING_PORTS_COMMAND),
  terminateProcess: (pid) => invoke(KILL_PORT_COMMAND, { pid }),
  inspectCommand: (command) => invoke(CHECK_COMMAND_EXISTS_COMMAND, { command }),
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

function inspectionId(): ProcessInspectionId {
  return crypto.randomUUID() as ProcessInspectionId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function transportError(error: unknown): SemanticServiceError<ProcessesErrorCode> {
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

function request<Input, Output>(
  context: SemanticServiceProviderContext,
  transport: PrivateSemanticRequestTransport<Input, Output, ProcessesErrorCode>,
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

/**
 * Trusted adapter for the current native process commands.
 *
 * Inspection identities are valid only for the latest successful scan in one
 * activation. The Phase D native provider will replace this frontend guard
 * with an operating-system identity that also detects PID reuse.
 */
export function createProcessesServiceProvider(
  options: ProcessesServiceProviderOptions = {},
): SemanticServiceProvider<ProcessesService> {
  const transport = options.transport ?? TAURI_PROCESSES_TRANSPORT;
  const createInspectionId = options.createInspectionId ?? inspectionId;

  return {
    service: processesService,
    bind(context) {
      const currentInspections = new Map<ProcessInspectionId, LegacyPortInfo>();

      const inspectListeningPorts = request<
        Readonly<Record<never, never>>,
        readonly ListeningProcessInspection[]
      >(context, {
        async request(envelope) {
          const rawPorts = await transport.listListeningPorts(envelope);
          const nextInspections = new Map<ProcessInspectionId, LegacyPortInfo>();
          const inspections = rawPorts.map((raw): ListeningProcessInspection => {
            const id = createInspectionId();
            if (nextInspections.has(id)) {
              throw new Error(`Duplicate process inspection identity: ${id}`);
            }
            nextInspections.set(id, raw);
            return {
              inspectionId: id,
              port: raw.port,
              processId: raw.pid,
              name: raw.process,
              workingDirectory: raw.cwd,
              projectName: raw.project,
              framework: raw.framework,
              uptime: raw.uptime,
              memoryKilobytes: raw.memoryKb,
            };
          });
          currentInspections.clear();
          for (const [id, raw] of nextInspections) currentInspections.set(id, raw);
          return { ok: true, value: inspections };
        },
      });

      const terminateInspectedProcess = request<
        TerminateInspectedProcessInput,
        TerminatedProcess
      >(context, {
        async request(envelope) {
          const { input } = envelope;
          const raw = currentInspections.get(input.inspectionId);
          if (!raw) {
            return {
              ok: false,
              error: {
                code: "processes.stale-inspection",
                message: "The process inspection is no longer current",
                retryable: false,
              },
            };
          }
          await transport.terminateProcess(raw.pid, envelope);
          for (const [id, candidate] of currentInspections) {
            if (candidate.pid === raw.pid) currentInspections.delete(id);
          }
          return {
            ok: true,
            value: { inspectionId: input.inspectionId },
          };
        },
      });

      const inspectCommand = request<InspectCommandInput, CommandInspection>(context, {
        async request(envelope) {
          const { input } = envelope;
          const command = input.command.trim();
          if (command.length === 0) {
            return {
              ok: false,
              error: {
                code: "processes.invalid-request",
                message: "Command cannot be empty",
                retryable: false,
              },
            };
          }
          const available = await transport.inspectCommand(command, envelope);
          const value: CommandInspection = { command, available };
          return { ok: true, value };
        },
      });

      return Object.freeze({
        inspectListeningPorts,
        terminateInspectedProcess,
        inspectCommand,
      });
    },
  };
}
