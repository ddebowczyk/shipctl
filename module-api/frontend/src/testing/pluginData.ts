import {
  pluginDataService,
  type MigratePluginDataRecordsInput,
  type PluginDataErrorCode,
  type PluginDataGrant,
  type PluginDataMigrationReceipt,
  type PluginDataRecord,
  type PluginDataRevision,
  type PluginDataScope,
  type PluginDataService,
  type ReadPluginDataRecordInput,
  type WritePluginDataRecordInput,
} from "../protocol/pluginData";
import type {
  SemanticCorrelationId,
  SemanticRequestOperation,
  SemanticServiceError,
} from "../protocol/semanticServices";
import type {
  SemanticServiceProvider,
  SemanticServiceProviderContext,
} from "../host/semanticServices";

import { createFakeRequestOperation } from "./semanticServices";

export type FakePluginDataOperation = "read" | "write" | "migrate";

export interface FakePluginDataPolicy {
  readonly moduleId: string;
  readonly scope: PluginDataScope["kind"];
  readonly key: string;
  readonly schemaVersions: readonly number[];
  readonly grants: readonly PluginDataGrant[];
}

export interface FakePluginDataRecordSeed {
  readonly ownerModuleId: string;
  readonly scope: PluginDataScope;
  readonly key: string;
  readonly schemaVersion: number;
  readonly revision?: number;
  readonly value: PluginDataRecord["value"];
}

export interface FakePluginDataTrace {
  readonly operation: FakePluginDataOperation;
  readonly activation: SemanticServiceProviderContext["activation"];
  readonly correlationId: SemanticCorrelationId;
  readonly scope?: PluginDataScope;
  readonly key?: string;
  readonly migrationId?: string;
}

export interface FakePluginDataProviderOptions {
  readonly policies?: readonly FakePluginDataPolicy[];
  readonly records?: readonly FakePluginDataRecordSeed[];
  readonly trace?: FakePluginDataTrace[];
}

const DEFAULT_POLICIES: readonly FakePluginDataPolicy[] = [
  {
    moduleId: "shipctl.usage",
    scope: "global",
    key: "settings",
    schemaVersions: [1],
    grants: ["plugin-data.read", "plugin-data.write", "plugin-data.migrate"],
  },
  {
    moduleId: "shipctl.commands",
    scope: "project",
    key: "commands",
    schemaVersions: [1],
    grants: ["plugin-data.read", "plugin-data.write", "plugin-data.migrate"],
  },
];

const REQUEST_POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

const CANCELLED = {
  code: "plugin-data.cancelled",
  message: "Plugin data request was cancelled",
  retryable: false,
} as const;

const DISPOSED = {
  code: "plugin-data.activation-disposed",
  message: "The module activation is no longer active",
  retryable: false,
} as const;

class FakePluginDataFailure extends Error {
  constructor(readonly code: PluginDataErrorCode, message: string) {
    super(message);
  }
}

function failure(error: unknown): SemanticServiceError<PluginDataErrorCode> {
  return error instanceof FakePluginDataFailure
    ? { code: error.code, message: error.message, retryable: false }
    : {
      code: "plugin-data.storage-failed",
      message: "The fake plugin data provider failed",
      retryable: false,
    };
}

function identity(moduleId: string, scope: PluginDataScope, key: string): string {
  return scope.kind === "global"
    ? `${moduleId}\u001fglobal\u001f${key}`
    : `${moduleId}\u001fproject\u001f${scope.projectId}\u001f${key}`;
}

function copyRecord(record: PluginDataRecord): PluginDataRecord {
  return structuredClone(record);
}

function assertIdentity(value: string, label: string) {
  if (!value.trim() || [...value].some((character) => /[\u0000-\u001f\u007f]/.test(character))) {
    throw new FakePluginDataFailure(
      "plugin-data.invalid-request",
      `Plugin data ${label} is invalid`,
    );
  }
}

function policyFor(
  policies: readonly FakePluginDataPolicy[],
  moduleId: string,
  scope: PluginDataScope,
  key: string,
  grant: PluginDataGrant,
): FakePluginDataPolicy {
  assertIdentity(key, "record key");
  if (scope.kind === "project") assertIdentity(scope.projectId, "project ID");
  const policy = policies.find((candidate) =>
    candidate.moduleId === moduleId
    && candidate.scope === scope.kind
    && candidate.key === key
    && candidate.grants.includes(grant));
  if (!policy) {
    throw new FakePluginDataFailure(
      "plugin-data.denied",
      "Plugin data access was denied",
    );
  }
  return policy;
}

function assertSchema(policy: FakePluginDataPolicy, version: number) {
  if (!Number.isSafeInteger(version) || version < 1 || !policy.schemaVersions.includes(version)) {
    throw new FakePluginDataFailure(
      "plugin-data.invalid-schema",
      "Plugin data schema version was not admitted",
    );
  }
}

function assertJsonSafe(value: unknown) {
  const ancestors = new Set<object>();
  const visit = (candidate: unknown): boolean => {
    if (
      candidate === null
      || typeof candidate === "string"
      || typeof candidate === "boolean"
    ) return true;
    if (typeof candidate === "number") return Number.isFinite(candidate);
    if (typeof candidate !== "object" || ancestors.has(candidate)) return false;
    ancestors.add(candidate);
    const valid = Array.isArray(candidate)
      ? candidate.every(visit)
      : Object.getPrototypeOf(candidate) === Object.prototype
        && Object.values(candidate).every(visit);
    ancestors.delete(candidate);
    return valid;
  };
  if (!visit(value)) {
    throw new FakePluginDataFailure(
      "plugin-data.invalid-value",
      "Plugin data value is not JSON-safe",
    );
  }
}

function nextRevision(record: PluginDataRecord | undefined): PluginDataRevision {
  const revision = (record?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision)) {
    throw new FakePluginDataFailure(
      "plugin-data.invalid-revision",
      "Plugin data revision cannot advance safely",
    );
  }
  return revision as PluginDataRevision;
}

function operation<Input, Output>(
  context: SemanticServiceProviderContext,
  name: FakePluginDataOperation,
  options: FakePluginDataProviderOptions,
  handle: (input: Input) => Output,
): SemanticRequestOperation<Input, Output, PluginDataErrorCode> {
  return createFakeRequestOperation({
    context,
    policy: REQUEST_POLICY,
    handle(request) {
      const input = request.input as Partial<
        ReadPluginDataRecordInput & MigratePluginDataRecordsInput
      >;
      options.trace?.push({
        operation: name,
        activation: request.activation,
        correlationId: request.correlationId,
        ...(input.scope ? { scope: structuredClone(input.scope) } : {}),
        ...(input.key ? { key: input.key } : {}),
        ...(input.migrationId ? { migrationId: input.migrationId } : {}),
      });
      return handle(request.input);
    },
    failedError: failure,
    cancelledError: CANCELLED,
    disposedError: DISPOSED,
  });
}

/** A Tauri-free durable provider. Its records outlive individual bindings. */
export function createFakePluginDataServiceProvider(
  options: FakePluginDataProviderOptions = {},
): SemanticServiceProvider<PluginDataService> {
  const policies = options.policies ?? DEFAULT_POLICIES;
  const records = new Map<string, PluginDataRecord>();
  for (const seed of options.records ?? []) {
    const record: PluginDataRecord = {
      ...structuredClone(seed),
      revision: (seed.revision ?? 1) as PluginDataRevision,
      migrations: [],
    };
    records.set(identity(seed.ownerModuleId, seed.scope, seed.key), record);
  }

  return {
    service: pluginDataService,
    bind(context) {
      const moduleId = context.activation.moduleId;
      return Object.freeze({
        readRecord: operation<ReadPluginDataRecordInput, PluginDataRecord | null>(
          context,
          "read",
          options,
          (input) => {
            policyFor(policies, moduleId, input.scope, input.key, "plugin-data.read");
            const record = records.get(identity(moduleId, input.scope, input.key));
            return record ? copyRecord(record) : null;
          },
        ),
        writeRecord: operation<WritePluginDataRecordInput, PluginDataRecord>(
          context,
          "write",
          options,
          (input) => {
            const policy = policyFor(
              policies,
              moduleId,
              input.scope,
              input.key,
              "plugin-data.write",
            );
            assertSchema(policy, input.schemaVersion);
            assertJsonSafe(input.value);
            const recordId = identity(moduleId, input.scope, input.key);
            const current = records.get(recordId);
            if (
              (current === undefined && input.expectedRevision !== null)
              || (current !== undefined && input.expectedRevision !== current.revision)
            ) {
              throw new FakePluginDataFailure(
                "plugin-data.conflict",
                "Plugin data write expected a stale record",
              );
            }
            const record: PluginDataRecord = {
              ownerModuleId: moduleId,
              scope: structuredClone(input.scope),
              key: input.key,
              schemaVersion: input.schemaVersion,
              revision: nextRevision(current),
              value: structuredClone(input.value),
              migrations: current?.migrations ?? [],
            };
            records.set(recordId, record);
            return copyRecord(record);
          },
        ),
        migrateRecords: operation<MigratePluginDataRecordsInput, PluginDataMigrationReceipt>(
          context,
          "migrate",
          options,
          (input) => {
            assertIdentity(input.migrationId, "migration ID");
            if (input.records.length === 0) {
              throw new FakePluginDataFailure(
                "plugin-data.invalid-request",
                "A plugin data migration must contain at least one record",
              );
            }
            const identities = new Set<string>();
            const current = input.records.map((write) => {
              const policy = policyFor(
                policies,
                moduleId,
                write.scope,
                write.key,
                "plugin-data.migrate",
              );
              assertSchema(policy, write.toSchemaVersion);
              assertJsonSafe(write.value);
              const recordId = identity(moduleId, write.scope, write.key);
              if (identities.has(recordId)) {
                throw new FakePluginDataFailure(
                  "plugin-data.invalid-request",
                  "A plugin data migration cannot repeat a record",
                );
              }
              identities.add(recordId);
              const record = records.get(recordId);
              if (!record) {
                throw new FakePluginDataFailure(
                  "plugin-data.not-found",
                  "Plugin data record was not found",
                );
              }
              return record;
            });
            const replayed = current.every((record, index) => {
              const write = input.records[index];
              return record.migrations.some((migration) =>
                migration.migrationId === input.migrationId
                && migration.fromSchemaVersion === write.fromSchemaVersion
                && migration.toSchemaVersion === write.toSchemaVersion);
            });
            if (replayed) {
              return {
                migrationId: input.migrationId,
                records: current.map(copyRecord),
                replayed: true,
              };
            }
            if (current.some((record) =>
              record.migrations.some((migration) => migration.migrationId === input.migrationId))) {
              throw new FakePluginDataFailure(
                "plugin-data.conflict",
                "Plugin data migration provenance is inconsistent",
              );
            }
            const migrated = current.map((record, index): PluginDataRecord => {
              const write = input.records[index];
              if (
                record.revision !== write.expectedRevision
                || record.schemaVersion !== write.fromSchemaVersion
                || write.fromSchemaVersion === write.toSchemaVersion
              ) {
                throw new FakePluginDataFailure(
                  "plugin-data.conflict",
                  "Plugin data migration expected a stale record",
                );
              }
              return {
                ownerModuleId: moduleId,
                scope: structuredClone(write.scope),
                key: write.key,
                schemaVersion: write.toSchemaVersion,
                revision: nextRevision(record),
                value: structuredClone(write.value),
                migrations: [...record.migrations, {
                  migrationId: input.migrationId,
                  fromSchemaVersion: write.fromSchemaVersion,
                  toSchemaVersion: write.toSchemaVersion,
                }],
              };
            });
            for (const record of migrated) {
              records.set(identity(moduleId, record.scope, record.key), record);
            }
            return {
              migrationId: input.migrationId,
              records: migrated.map(copyRecord),
              replayed: false,
            };
          },
        ),
      });
    },
  };
}
