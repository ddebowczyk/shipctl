import { invoke } from "@tauri-apps/api/core";

import type {
  WorkspacePersistedRecord,
  WorkspaceRevision,
} from "@shipctl/module-api";
import {
  parseWorkspacePersistedRecord,
  workspaceDocumentEqual,
  type WorkspacePersistencePort,
} from "@shipctl/core/workspace";

const LOAD_WORKSPACE_DOCUMENT_COMMAND = "load_workspace_document";
const SAVE_WORKSPACE_DOCUMENT_COMMAND = "save_workspace_document";

type InvokeCommand = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface WorkspaceDocumentSaved {
  readonly status: "saved";
  readonly record: unknown;
}

interface WorkspaceDocumentConflict {
  readonly status: "conflict";
  readonly current: unknown | null;
}

type WorkspaceDocumentSaveResponse = WorkspaceDocumentSaved | WorkspaceDocumentConflict;

/** A stable, payload-free failure from the semantic workspace Tauri port. */
export class WorkspacePersistencePortError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "WorkspacePersistencePortError";
    this.code = code;
  }
}

export interface TauriWorkspacePersistencePortOptions {
  readonly invokeCommand?: InvokeCommand;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function invalidTransport(message: string): WorkspacePersistencePortError {
  return new WorkspacePersistencePortError("WORKSPACE_PERSISTENCE_TRANSPORT_INVALID", message);
}

function invalidRequest(message: string): WorkspacePersistencePortError {
  return new WorkspacePersistencePortError("WORKSPACE_PERSISTENCE_REQUEST_INVALID", message);
}

function readWorkspaceRecord(
  value: unknown,
  workspaceId: string,
  source: string,
): WorkspacePersistedRecord {
  let record: WorkspacePersistedRecord;
  try {
    record = parseWorkspacePersistedRecord(value);
  } catch {
    throw invalidTransport(`${source} did not contain a valid semantic workspace record.`);
  }
  if (record.workspaceId !== workspaceId) {
    throw invalidTransport(`${source} was returned for a different workspace.`);
  }
  return record;
}

function readSaveRequest(input: Parameters<WorkspacePersistencePort["compareAndSave"]>[0]): {
  readonly workspaceId: string;
  readonly expectedRevision: WorkspaceRevision;
  readonly record: WorkspacePersistedRecord;
} {
  if (!isIdentity(input.workspaceId)) {
    throw invalidRequest("Semantic workspace save requires a workspace identifier.");
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw invalidRequest("Semantic workspace save has an invalid expected revision.");
  }
  let record: WorkspacePersistedRecord;
  try {
    record = parseWorkspacePersistedRecord(input.record);
  } catch {
    throw invalidRequest("Semantic workspace save has an invalid record.");
  }
  if (record.workspaceId !== input.workspaceId) {
    throw invalidRequest("Semantic workspace save cannot write another workspace.");
  }
  if (record.revision !== input.expectedRevision + 1) {
    throw invalidRequest("Semantic workspace record revision does not advance by one.");
  }
  return { workspaceId: input.workspaceId, expectedRevision: input.expectedRevision, record };
}

function defaultInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

/**
 * The sole browser mapping from the semantic workspace persistence port to
 * Tauri. It exchanges only durable workspace envelopes; no Layman snapshot or
 * renderer object crosses this boundary.
 */
export function createTauriWorkspacePersistencePort(
  options: TauriWorkspacePersistencePortOptions = {},
): WorkspacePersistencePort {
  const invokeCommand = options.invokeCommand ?? defaultInvoke;

  return {
    async load(workspaceId) {
      if (!isIdentity(workspaceId)) {
        throw invalidRequest("Semantic workspace load requires a workspace identifier.");
      }
      const response = await invokeCommand<unknown>(LOAD_WORKSPACE_DOCUMENT_COMMAND, { workspaceId });
      if (response === null || response === undefined) return undefined;
      return readWorkspaceRecord(response, workspaceId, "Semantic workspace load response");
    },

    async compareAndSave(input) {
      const request = readSaveRequest(input);
      const response = await invokeCommand<WorkspaceDocumentSaveResponse>(
        SAVE_WORKSPACE_DOCUMENT_COMMAND,
        {
          workspaceId: request.workspaceId,
          expectedRevision: request.expectedRevision,
          record: request.record,
        },
      );
      if (!isRecord(response) || typeof response.status !== "string") {
        throw invalidTransport("Semantic workspace save response has no status.");
      }

      if (response.status === "saved") {
        const record = readWorkspaceRecord(
          response.record,
          request.workspaceId,
          "Semantic workspace save response",
        );
        if (
          record.revision !== request.expectedRevision + 1
          || record.originId !== request.record.originId
          || record.catalogRevision !== request.record.catalogRevision
          || !workspaceDocumentEqual(record.document, request.record.document)
        ) {
          throw invalidTransport("Semantic workspace save response does not confirm the requested record.");
        }
        return { status: "saved", record };
      }

      if (response.status === "conflict") {
        if (response.current === null || response.current === undefined) {
          if (request.expectedRevision === 0) {
            throw invalidTransport("Semantic workspace conflict has no current record.");
          }
          return { status: "conflict", current: undefined };
        }
        const current = readWorkspaceRecord(
          response.current,
          request.workspaceId,
          "Semantic workspace conflict response",
        );
        if (current.revision <= request.expectedRevision) {
          throw invalidTransport("Semantic workspace conflict is not newer than the requested revision.");
        }
        return { status: "conflict", current };
      }

      throw invalidTransport("Semantic workspace save response has an unknown status.");
    },
  };
}
