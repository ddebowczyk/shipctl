import { defineSemanticService } from "./semanticServices.ts";
import type { SemanticRequestOperation } from "./semanticServices";

declare const processInspectionIdBrand: unique symbol;

/** Opaque identity for one result from the latest successful inspection. */
export type ProcessInspectionId = string & {
  readonly [processInspectionIdBrand]: true;
};

export interface InspectListeningProcessesInput {
  /** File names used to find the nearest relevant ancestor of a process CWD. */
  readonly projectRootMarkers: readonly string[];
  /** File names to observe at that root without assigning them native meaning. */
  readonly observedProjectFileNames: readonly string[];
}

export interface ListeningProcessInspection {
  readonly inspectionId: ProcessInspectionId;
  readonly port: number;
  readonly processId: number;
  readonly name: string;
  readonly workingDirectory: string;
  readonly commandLine: string;
  readonly observedProjectFiles: readonly string[];
  readonly uptime: string;
  readonly memoryKilobytes: number;
}

export interface TerminateInspectedProcessInput {
  readonly inspectionId: ProcessInspectionId;
}

export interface TerminatedProcess {
  readonly inspectionId: ProcessInspectionId;
}

export interface InspectCommandInput {
  readonly command: string;
}

export interface CommandInspection {
  readonly command: string;
  readonly available: boolean;
}

export type ProcessesErrorCode =
  | "processes.transport-failed"
  | "processes.denied"
  | "processes.stale-inspection"
  | "processes.cancelled"
  | "processes.activation-disposed"
  | "processes.invalid-request";

export interface ProcessesService {
  readonly inspectListeningPorts: SemanticRequestOperation<
    InspectListeningProcessesInput,
    readonly ListeningProcessInspection[],
    ProcessesErrorCode
  >;
  readonly terminateInspectedProcess: SemanticRequestOperation<
    TerminateInspectedProcessInput,
    TerminatedProcess,
    ProcessesErrorCode
  >;
  readonly inspectCommand: SemanticRequestOperation<
    InspectCommandInput,
    CommandInspection,
    ProcessesErrorCode
  >;
}

export const processesService = defineSemanticService<ProcessesService>(
  "shipctl.processes",
  1,
);
