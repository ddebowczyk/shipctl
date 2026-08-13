import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type {
  LaymanSnapshotPort,
  LaymanSnapshotSaveRequest,
  LaymanWorkspaceUpdate,
} from "@shipctl/core/canvas/views";

const LOAD_WORKSPACE_LAYOUT_COMMAND = "load_workspace_layout";
const SAVE_WORKSPACE_LAYOUT_COMMAND = "save_workspace_layout";
const WORKSPACE_LAYOUT_CHANGED_EVENT = "shipctl://workspace-layout-changed";
const WORKSPACE_LAYOUT_RECORD_SCHEMA_VERSION = 1;

type InvokeCommand = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type ListenEvent = <T>(
  event: string,
  receive: (event: { readonly payload: T }) => void,
) => Promise<() => void>;

export interface WorkspaceLayoutRecord {
  readonly schemaVersion: number;
  readonly workspaceId: string;
  readonly revision: number;
  readonly originId: string;
  readonly snapshot: unknown;
}

interface WorkspaceLayoutSaved {
  readonly status: "saved";
  readonly record: unknown;
}

interface WorkspaceLayoutConflict {
  readonly status: "conflict";
  readonly current: unknown;
}

type WorkspaceLayoutSaveResponse = WorkspaceLayoutSaved | WorkspaceLayoutConflict;

/** A stable, payload-free error from the host layout transport. */
export class WorkspaceLayoutPortError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "WorkspaceLayoutPortError";
    this.code = code;
  }
}

export interface TauriWorkspaceLayoutPortOptions {
  readonly invokeCommand?: InvokeCommand;
  readonly listenEvent?: ListenEvent;
  /** Receives malformed event payloads that cannot be sent through Layman. */
  readonly onTransportError?: (error: WorkspaceLayoutPortError) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function invalidTransport(message: string): WorkspaceLayoutPortError {
  return new WorkspaceLayoutPortError("CANVAS_LAYOUT_TRANSPORT_INVALID", message);
}

function readLayoutRecord(value: unknown, source: string): WorkspaceLayoutRecord {
  if (!isRecord(value)) {
    throw invalidTransport(`${source} did not contain a workspace layout record.`);
  }
  if (value.schemaVersion !== WORKSPACE_LAYOUT_RECORD_SCHEMA_VERSION) {
    throw new WorkspaceLayoutPortError(
      "CANVAS_LAYOUT_STORAGE_SCHEMA_UNSUPPORTED",
      `${source} has an unsupported workspace layout schema.`,
    );
  }
  if (!isIdentity(value.workspaceId) || !isIdentity(value.originId)) {
    throw invalidTransport(`${source} is missing a workspace or origin identifier.`);
  }
  if (
    typeof value.revision !== "number"
    || !Number.isSafeInteger(value.revision)
    || value.revision < 1
  ) {
    throw new WorkspaceLayoutPortError(
      "CANVAS_LAYOUT_REVISION_INVALID",
      `${source} has an invalid layout revision.`,
    );
  }
  if (!("snapshot" in value)) {
    throw invalidTransport(`${source} is missing its layout snapshot.`);
  }
  return {
    schemaVersion: value.schemaVersion,
    workspaceId: value.workspaceId,
    revision: value.revision,
    originId: value.originId,
    snapshot: value.snapshot,
  };
}

function readWorkspaceRecord(value: unknown, workspaceId: string, source: string): WorkspaceLayoutRecord {
  const record = readLayoutRecord(value, source);
  if (record.workspaceId !== workspaceId) {
    throw invalidTransport(`${source} was returned for a different workspace.`);
  }
  return record;
}

function toLaymanUpdate(record: WorkspaceLayoutRecord): LaymanWorkspaceUpdate {
  return {
    revision: record.revision,
    originId: record.originId,
    snapshot: record.snapshot,
  };
}

function readSaveRequest(request: LaymanSnapshotSaveRequest): LaymanSnapshotSaveRequest {
  if (!isRecord(request)) {
    throw invalidTransport("Layman attempted to save an invalid layout request.");
  }
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
    throw new WorkspaceLayoutPortError(
      "CANVAS_LAYOUT_REVISION_INVALID",
      "Layman attempted to save an invalid expected layout revision.",
    );
  }
  if (!isIdentity(request.originId)) {
    throw new WorkspaceLayoutPortError(
      "CANVAS_LAYOUT_IDENTITY_INVALID",
      "Layman attempted to save without an origin identifier.",
    );
  }
  if (!("snapshot" in request)) {
    throw invalidTransport("Layman attempted to save without a layout snapshot.");
  }
  return request;
}

function defaultInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

function defaultListen<T>(
  event: string,
  receive: (event: { readonly payload: T }) => void,
): Promise<() => void> {
  return listen<T>(event, receive);
}

/**
 * The sole browser mapping from Layman's generic SnapshotPort to Shipctl's
 * Tauri commands and event. Callers receive only Layman's transport contract.
 */
export function createTauriWorkspaceLayoutSnapshotPort(
  options: TauriWorkspaceLayoutPortOptions = {},
): LaymanSnapshotPort {
  const invokeCommand = options.invokeCommand ?? defaultInvoke;
  const listenEvent = options.listenEvent ?? defaultListen;

  return {
    async load(workspaceId) {
      const result = await invokeCommand<unknown>(LOAD_WORKSPACE_LAYOUT_COMMAND, { workspaceId });
      if (result === null || result === undefined) return undefined;
      return toLaymanUpdate(readWorkspaceRecord(result, workspaceId, "Layout load response"));
    },

    async compareAndSave(workspaceId, update) {
      const request = readSaveRequest(update);
      const response = await invokeCommand<WorkspaceLayoutSaveResponse>(
        SAVE_WORKSPACE_LAYOUT_COMMAND,
        {
          workspaceId,
          expectedRevision: request.expectedRevision,
          originId: request.originId,
          snapshot: request.snapshot,
        },
      );
      if (!isRecord(response) || typeof response.status !== "string") {
        throw invalidTransport("Layout save response has no status.");
      }

      if (response.status === "saved") {
        const record = readWorkspaceRecord(response.record, workspaceId, "Layout save response");
        if (
          record.revision <= request.expectedRevision
          || record.originId !== request.originId
        ) {
          throw invalidTransport("Layout save response does not confirm the requested layout.");
        }
        return { status: "saved", update: toLaymanUpdate(record) };
      }

      if (response.status === "conflict") {
        if (response.current === null || response.current === undefined) {
          throw invalidTransport("Layout conflict response does not contain a current record.");
        }
        const current = readWorkspaceRecord(
          response.current,
          workspaceId,
          "Layout conflict response",
        );
        if (current.revision <= request.expectedRevision) {
          throw invalidTransport("Layout conflict response is not newer than the requested revision.");
        }
        return { status: "conflict", current: toLaymanUpdate(current) };
      }

      throw invalidTransport("Layout save response has an unknown status.");
    },

    async subscribe(workspaceId, receive) {
      let active = true;
      const unlisten = await listenEvent<unknown>(WORKSPACE_LAYOUT_CHANGED_EVENT, (event) => {
        if (!active) return;
        try {
          const record = readLayoutRecord(event.payload, "Layout change event");
          if (record.workspaceId === workspaceId) {
            receive(toLaymanUpdate(record));
          }
        } catch (error) {
          if (error instanceof WorkspaceLayoutPortError) {
            options.onTransportError?.(error);
          } else {
            options.onTransportError?.(invalidTransport("Layout change event could not be read."));
          }
        }
      });
      return () => {
        active = false;
        unlisten();
      };
    },
  };
}
