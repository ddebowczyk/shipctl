import {
  WORKSPACE_PERSISTENCE_SCHEMA_VERSION,
  type PluginDataRecord,
  type PluginDataRevision,
  type PluginDataService,
  type ModuleJsonValue,
  type UiWorkspaceDocument,
  type WorkspaceNode,
  type WorkspacePersistedRecord,
  type WorkspaceRevision,
  type WorkspaceStackNode,
} from "@shipctl/module-api";

import { parseUiWorkspaceDocument, parseWorkspacePersistedRecord } from "./document.ts";
import type { WorkspacePersistencePort } from "./persistence.ts";

/**
 * Schema 3 is the canonical plugin-owned record. Schema 1 is reserved for a
 * read-only legacy record-map value and the brief pre-release wrapper shape;
 * schema 2 is the first canonical wrapper, whose workspace may still contain
 * the retired compatibility canvas. Both migrate through generic plugin-data
 * provenance before the authority consumes them.
 */
const WORKSPACE_PLUGIN_DATA_SCHEMA_VERSION = 3;
const PREVIOUS_WORKSPACE_PLUGIN_DATA_SCHEMA_VERSION = 2;
const LEGACY_WORKSPACE_PLUGIN_DATA_SCHEMA_VERSION = 1;
const WORKSPACE_PLUGIN_DATA_MIGRATION_IDS = Object.freeze({
  [LEGACY_WORKSPACE_PLUGIN_DATA_SCHEMA_VERSION]: "workspace-document-record-v1-to-plugin-data-v3",
  [PREVIOUS_WORKSPACE_PLUGIN_DATA_SCHEMA_VERSION]: "workspace-remove-retired-canvas-v2-to-v3",
});
const RETIRED_COMPATIBILITY_VIEW_TYPE_ID = "shipctl.legacy-canvas";
const GLOBAL_SCOPE = { kind: "global" } as const;

interface WorkspacePluginDataValue {
  readonly schemaVersion: number;
  readonly workspaceId: string;
  readonly originId: string;
  /** Kept inside the opaque owner value, never as generic plugin-data metadata. */
  readonly catalogRevision: number;
  readonly document: unknown;
}

export class WorkspacePluginDataPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePluginDataPersistenceError";
  }
}

function key(workspaceId: string): string {
  return `workspace-document:${workspaceId}`;
}

function asValue(
  value: unknown,
  schemaVersion: number,
): WorkspacePluginDataValue {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new WorkspacePluginDataPersistenceError("Workspace plugin data value is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== schemaVersion
    || typeof candidate.workspaceId !== "string"
    || typeof candidate.originId !== "string"
    || !Number.isSafeInteger(candidate.catalogRevision)
    || (candidate.catalogRevision as number) < 0
    || !("document" in candidate)
  ) {
    throw new WorkspacePluginDataPersistenceError("Workspace plugin data value is invalid.");
  }
  return candidate as unknown as WorkspacePluginDataValue;
}

function toWorkspaceRecord(record: PluginDataRecord, workspaceId: string): WorkspacePersistedRecord {
  if (
    record.scope.kind !== "global"
    || record.key !== key(workspaceId)
    || record.schemaVersion !== WORKSPACE_PLUGIN_DATA_SCHEMA_VERSION
    || record.ownerModuleId !== WORKSPACE_PLUGIN_MODULE_ID
  ) {
    throw new WorkspacePluginDataPersistenceError("Workspace plugin data record is not owned by this workspace runtime.");
  }
  const value = asValue(record.value, WORKSPACE_PLUGIN_DATA_SCHEMA_VERSION);
  if (value.workspaceId !== workspaceId) {
    throw new WorkspacePluginDataPersistenceError("Workspace plugin data record belongs to another workspace.");
  }
  try {
    return parseWorkspacePersistedRecord({
      storageSchemaVersion: WORKSPACE_PERSISTENCE_SCHEMA_VERSION,
      workspaceId,
      revision: record.revision,
      originId: value.originId,
      catalogRevision: value.catalogRevision,
      document: value.document,
    });
  } catch (error) {
    throw new WorkspacePluginDataPersistenceError(
      error instanceof Error ? error.message : "Workspace plugin data record is invalid.",
    );
  }
}

function toPluginDataValue(record: Pick<
  WorkspacePersistedRecord,
  "workspaceId" | "originId" | "catalogRevision" | "document"
>): ModuleJsonValue {
  return Object.freeze({
    schemaVersion: WORKSPACE_PLUGIN_DATA_SCHEMA_VERSION,
    workspaceId: record.workspaceId,
    originId: record.originId,
    catalogRevision: record.catalogRevision,
    document: record.document,
  }) as unknown as ModuleJsonValue;
}

function pruneRetiredStack(
  stack: WorkspaceStackNode,
  retiredInstanceIds: ReadonlySet<string>,
): WorkspaceStackNode | null {
  const instanceIds = stack.instanceIds.filter((instanceId) => !retiredInstanceIds.has(instanceId));
  if (instanceIds.length === 0) return null;
  return {
    ...stack,
    instanceIds,
    selectedInstanceId: retiredInstanceIds.has(stack.selectedInstanceId)
      ? instanceIds[0]!
      : stack.selectedInstanceId,
  };
}

function pruneRetiredNode(
  node: WorkspaceNode,
  retiredInstanceIds: ReadonlySet<string>,
): WorkspaceNode | null {
  if (node.kind === "stack") return pruneRetiredStack(node, retiredInstanceIds);
  const first = pruneRetiredNode(node.first, retiredInstanceIds);
  const second = pruneRetiredNode(node.second, retiredInstanceIds);
  if (first === null) return second;
  if (second === null) return first;
  return { ...node, first, second };
}

function collectStackIds(node: WorkspaceNode | null, stackIds: Set<string>): void {
  if (node === null) return;
  if (node.kind === "stack") {
    stackIds.add(node.stackId);
    return;
  }
  collectStackIds(node.first, stackIds);
  collectStackIds(node.second, stackIds);
}

/** Removes only the host compatibility view retired with the semantic workspace rollout. */
function withoutRetiredCompatibilityCanvas(document: UiWorkspaceDocument): UiWorkspaceDocument {
  const retiredInstanceIds = new Set(
    document.instances
      .filter(({ viewTypeId }) => viewTypeId === RETIRED_COMPATIBILITY_VIEW_TYPE_ID)
      .map(({ instanceId }) => instanceId),
  );
  if (retiredInstanceIds.size === 0) return document;

  const root = document.root === null ? null : pruneRetiredNode(document.root, retiredInstanceIds);
  const floating = document.floating.flatMap((item) => {
    const stack = pruneRetiredStack(item.stack, retiredInstanceIds);
    return stack === null ? [] : [{ ...item, stack }];
  });
  const stackIds = new Set<string>();
  collectStackIds(root, stackIds);
  for (const item of floating) stackIds.add(item.stack.stackId);
  return parseUiWorkspaceDocument({
    ...document,
    instances: document.instances.filter(({ instanceId }) => !retiredInstanceIds.has(instanceId)),
    root,
    floating,
    maximizedStackId: document.maximizedStackId !== null && stackIds.has(document.maximizedStackId)
      ? document.maximizedStackId
      : null,
  });
}

function migrationPluginDataValue(record: PluginDataRecord, workspaceId: string): ModuleJsonValue {
  let legacy: WorkspacePersistedRecord;
  try {
    if (record.schemaVersion === LEGACY_WORKSPACE_PLUGIN_DATA_SCHEMA_VERSION &&
      record.value !== null
      && typeof record.value === "object"
      && !Array.isArray(record.value)
      && "storageSchemaVersion" in record.value
    ) {
      // The generic native read-through source exposes the old opaque
      // workspace envelope as-is. Its old revision is intentionally audited by
      // parsing but the new generic record begins at revision one.
      legacy = parseWorkspacePersistedRecord(record.value);
    } else {
      // This accommodates an unpublished schema-1 wrapper created before the
      // canonical plugin-data migration existed, as well as schema 2 records
      // written before the compatibility canvas was retired.
      const value = asValue(record.value, record.schemaVersion);
      legacy = parseWorkspacePersistedRecord({
        storageSchemaVersion: WORKSPACE_PERSISTENCE_SCHEMA_VERSION,
        workspaceId,
        revision: record.revision,
        originId: value.originId,
        catalogRevision: value.catalogRevision,
        document: value.document,
      });
    }
  } catch (error) {
    throw new WorkspacePluginDataPersistenceError(
      error instanceof Error ? error.message : "Legacy workspace plugin data record is invalid.",
    );
  }
  if (legacy.workspaceId !== workspaceId) {
    throw new WorkspacePluginDataPersistenceError("Legacy workspace plugin data record belongs to another workspace.");
  }
  return toPluginDataValue({
    ...legacy,
    document: withoutRetiredCompatibilityCanvas(legacy.document),
  });
}

function pluginDataError(error: { readonly code: string; readonly message: string }): WorkspacePluginDataPersistenceError {
  return new WorkspacePluginDataPersistenceError(`${error.code}: ${error.message}`);
}

/**
 * Adapts the generic, activation-authorized plugin-data service to the
 * workspace authority's exact compare-and-save contract. The plugin-data
 * record revision is the workspace revision; catalogRevision remains private
 * to this owner's opaque value.
 */
export class PluginDataWorkspacePersistence implements WorkspacePersistencePort {
  readonly #pluginData: PluginDataService;

  constructor(pluginData: PluginDataService) {
    this.#pluginData = pluginData;
  }

  async load(workspaceId: string): Promise<WorkspacePersistedRecord | undefined> {
    const record = await this.#read(workspaceId);
    return record === null ? undefined : this.#canonicalRecord(record, workspaceId);
  }

  async compareAndSave(input: {
    readonly workspaceId: string;
    readonly expectedRevision: WorkspaceRevision;
    readonly record: WorkspacePersistedRecord;
  }): Promise<
    | { readonly status: "saved"; readonly record: WorkspacePersistedRecord }
    | { readonly status: "conflict"; readonly current: WorkspacePersistedRecord | undefined }
  > {
    const candidate = parseWorkspacePersistedRecord(input.record);
    if (candidate.workspaceId !== input.workspaceId) {
      throw new WorkspacePluginDataPersistenceError("Workspace persistence cannot write another workspace.");
    }
    if (candidate.revision !== input.expectedRevision + 1) {
      throw new WorkspacePluginDataPersistenceError("Workspace persistence revision does not advance by one.");
    }
    const outcome = await this.#pluginData.writeRecord.execute({
      scope: GLOBAL_SCOPE,
      key: key(input.workspaceId),
      expectedRevision: input.expectedRevision === 0
        ? null
        : input.expectedRevision as unknown as PluginDataRevision,
      schemaVersion: WORKSPACE_PLUGIN_DATA_SCHEMA_VERSION,
      value: toPluginDataValue(candidate),
    });
    if (outcome.result.ok) {
      const saved = toWorkspaceRecord(outcome.result.value, input.workspaceId);
      if (saved.revision !== candidate.revision) {
        throw new WorkspacePluginDataPersistenceError("Workspace plugin data write returned an unexpected revision.");
      }
      return { status: "saved", record: saved };
    }
    if (outcome.result.error.code !== "plugin-data.conflict") {
      throw pluginDataError(outcome.result.error);
    }
    const current = await this.load(input.workspaceId);
    return {
      status: "conflict",
      current,
    };
  }

  async #read(workspaceId: string): Promise<PluginDataRecord | null> {
    const outcome = await this.#pluginData.readRecord.execute({
      scope: GLOBAL_SCOPE,
      key: key(workspaceId),
    });
    if (!outcome.result.ok) throw pluginDataError(outcome.result.error);
    return outcome.result.value;
  }

  async #canonicalRecord(
    record: PluginDataRecord,
    workspaceId: string,
  ): Promise<WorkspacePersistedRecord> {
    if (record.schemaVersion === WORKSPACE_PLUGIN_DATA_SCHEMA_VERSION) {
      return toWorkspaceRecord(record, workspaceId);
    }
    if (
      record.schemaVersion !== LEGACY_WORKSPACE_PLUGIN_DATA_SCHEMA_VERSION
      && record.schemaVersion !== PREVIOUS_WORKSPACE_PLUGIN_DATA_SCHEMA_VERSION
    ) {
      throw new WorkspacePluginDataPersistenceError("Workspace plugin data record uses an unsupported schema.");
    }
    const migrationId = WORKSPACE_PLUGIN_DATA_MIGRATION_IDS[record.schemaVersion];
    const outcome = await this.#pluginData.migrateRecords.execute({
      migrationId,
      records: [{
        scope: GLOBAL_SCOPE,
        key: key(workspaceId),
        expectedRevision: record.revision,
        fromSchemaVersion: record.schemaVersion,
        toSchemaVersion: WORKSPACE_PLUGIN_DATA_SCHEMA_VERSION,
        value: migrationPluginDataValue(record, workspaceId),
      }],
    });
    if (outcome.result.ok) {
      const migrated = outcome.result.value.records[0];
      if (migrated === undefined) {
        throw new WorkspacePluginDataPersistenceError("Workspace plugin data migration returned no record.");
      }
      return toWorkspaceRecord(migrated, workspaceId);
    }
    if (outcome.result.error.code === "plugin-data.conflict") {
      const current = await this.#read(workspaceId);
      if (current !== null && current.schemaVersion === WORKSPACE_PLUGIN_DATA_SCHEMA_VERSION) {
        return toWorkspaceRecord(current, workspaceId);
      }
    }
    throw pluginDataError(outcome.result.error);
  }
}

/** Stable trusted owner identity; no ordinary plugin can select this namespace. */
export const WORKSPACE_PLUGIN_MODULE_ID = "shipctl.workspace";
export const WORKSPACE_PLUGIN_DATA_KEY = key;
