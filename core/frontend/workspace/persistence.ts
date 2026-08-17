import type {
  WorkspacePersistedRecord,
  WorkspaceRevision,
} from "@shipctl/module-api";

import { cloneAndFreeze } from "./internal.ts";
import { parseWorkspacePersistedRecord } from "./document.ts";

/** The persistence boundary owns compare-and-save, never renderer snapshots. */
export interface WorkspacePersistencePort {
  load(workspaceId: string): Promise<WorkspacePersistedRecord | undefined>;
  compareAndSave(input: {
    readonly workspaceId: string;
    readonly expectedRevision: WorkspaceRevision;
    readonly record: WorkspacePersistedRecord;
  }): Promise<
    | { readonly status: "saved"; readonly record: WorkspacePersistedRecord }
    | { readonly status: "conflict"; readonly current: WorkspacePersistedRecord | undefined }
  >;
}

/**
 * A deterministic test and headless-host persistence port. It models the
 * exact conflict behavior required from the eventual Tauri adapter.
 */
export class InMemoryWorkspacePersistence implements WorkspacePersistencePort {
  readonly #records = new Map<string, WorkspacePersistedRecord>();

  constructor(records: readonly WorkspacePersistedRecord[] = []) {
    for (const record of records) {
      const parsed = parseWorkspacePersistedRecord(record);
      if (this.#records.has(parsed.workspaceId)) {
        throw new Error(`Workspace ${parsed.workspaceId} is seeded more than once.`);
      }
      this.#records.set(parsed.workspaceId, parsed);
    }
  }

  async load(workspaceId: string): Promise<WorkspacePersistedRecord | undefined> {
    const record = this.#records.get(workspaceId);
    return record === undefined ? undefined : cloneAndFreeze(record);
  }

  async compareAndSave(input: {
    readonly workspaceId: string;
    readonly expectedRevision: WorkspaceRevision;
    readonly record: WorkspacePersistedRecord;
  }): Promise<
    | { readonly status: "saved"; readonly record: WorkspacePersistedRecord }
    | { readonly status: "conflict"; readonly current: WorkspacePersistedRecord | undefined }
  > {
    const next = parseWorkspacePersistedRecord(input.record);
    if (next.workspaceId !== input.workspaceId) {
      throw new Error("Workspace persistence cannot save another workspace.");
    }
    const current = this.#records.get(input.workspaceId);
    const currentRevision = current?.revision ?? 0;
    if (input.expectedRevision !== currentRevision) {
      return {
        status: "conflict",
        current: current === undefined ? undefined : cloneAndFreeze(current),
      };
    }
    if (next.revision !== currentRevision + 1) {
      throw new Error("Workspace persistence record revision does not advance by one.");
    }
    this.#records.set(input.workspaceId, next);
    return { status: "saved", record: cloneAndFreeze(next) };
  }
}
