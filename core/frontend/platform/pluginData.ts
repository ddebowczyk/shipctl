import { invoke } from "@tauri-apps/api/core";
import {
  pluginDataService,
  type MigratePluginDataRecordsInput,
  type ModuleActivationIdentity,
  type ModuleJsonValue,
  type PluginDataErrorCode,
  type PluginDataGrant,
  type PluginDataMigrationReceipt,
  type PluginDataRecord,
  type PluginDataRevision,
  type PluginDataScope,
  type PluginDataService,
  type ReadPluginDataRecordInput,
  type SemanticServiceError,
  type SemanticServiceProvider,
  type SemanticServiceProviderContext,
  type WritePluginDataRecordInput,
} from "@shipctl/module-api";

import {
  createSemanticRequestAdapter,
  type PrivateSemanticRequestEnvelope,
  type PrivateSemanticRequestTransport,
} from "./semanticServiceAdapter.ts";

const COMMANDS = {
  read: "read_plugin_data_record",
  write: "write_plugin_data_record",
  migrate: "migrate_plugin_data_records",
} as const;

export interface PluginDataTransport {
  read(
    request: PrivateSemanticRequestEnvelope<ReadPluginDataRecordInput>,
  ): Promise<PluginDataRecord | null>;
  write(
    request: PrivateSemanticRequestEnvelope<WritePluginDataRecordInput>,
  ): Promise<PluginDataRecord>;
  migrate(
    request: PrivateSemanticRequestEnvelope<MigratePluginDataRecordsInput>,
  ): Promise<PluginDataMigrationReceipt>;
}

export interface PluginDataAuthorizationRequest {
  readonly activation: ModuleActivationIdentity;
  readonly grant: PluginDataGrant;
  readonly scope: PluginDataScope;
  readonly key: string;
  readonly schemaVersion?: number;
}

export type PluginDataAuthorizer = (request: PluginDataAuthorizationRequest) => boolean;

export interface PluginDataServiceProviderOptions {
  readonly transport?: PluginDataTransport;
  readonly authorize?: PluginDataAuthorizer;
}

const TAURI_TRANSPORT: PluginDataTransport = {
  read: (request) => invoke(COMMANDS.read, { request }),
  write: (request) => invoke(COMMANDS.write, { request }),
  migrate: (request) => invoke(COMMANDS.migrate, { request }),
};

const POLICY = {
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

const ERROR_CODES = new Set<PluginDataErrorCode>([
  "plugin-data.transport-failed",
  "plugin-data.denied",
  "plugin-data.invalid-request",
  "plugin-data.invalid-project",
  "plugin-data.invalid-schema",
  "plugin-data.invalid-value",
  "plugin-data.invalid-revision",
  "plugin-data.not-found",
  "plugin-data.conflict",
  "plugin-data.storage-failed",
  "plugin-data.unavailable",
  "plugin-data.cancelled",
  "plugin-data.activation-disposed",
]);

const DEFAULT_AUTHORIZE: PluginDataAuthorizer = ({
  activation,
  grant,
  scope,
  key,
  schemaVersion,
}) => {
  const admitted = activation.moduleId === "shipctl.usage"
    ? scope.kind === "global" && key === "settings"
    : activation.moduleId === "shipctl.commands"
      ? scope.kind === "project" && key === "commands"
      : false;
  return admitted
    && ["plugin-data.read", "plugin-data.write", "plugin-data.migrate"].includes(grant)
    && (schemaVersion === undefined || schemaVersion === 1);
};

function transportError(error: unknown): SemanticServiceError<PluginDataErrorCode> {
  const message = error instanceof Error ? error.message : String(error);
  const match = /\b(plugin-data\.[a-z-]+)(?::|\b)/.exec(message);
  const code = match && ERROR_CODES.has(match[1] as PluginDataErrorCode)
    ? match[1] as PluginDataErrorCode
    : message.toLowerCase().includes("unknown command")
      ? "plugin-data.unavailable"
      : "plugin-data.transport-failed";
  return { code, message, retryable: false };
}

function failure(code: PluginDataErrorCode, message: string) {
  return { ok: false, error: { code, message, retryable: false } } as const;
}

function validIdentity(value: string): boolean {
  return value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validScope(scope: PluginDataScope): boolean {
  return scope.kind === "global"
    || (scope.kind === "project" && validIdentity(scope.projectId));
}

function validRevision(value: PluginDataRevision | null): boolean {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function validSchemaVersion(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function jsonSafe(value: unknown, ancestors = new Set<object>()): value is ModuleJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => jsonSafe(item, ancestors))
    : Object.getPrototypeOf(value) === Object.prototype
      && Object.values(value).every((item) => jsonSafe(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function validMigrationProvenance(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const migration = value as Record<string, unknown>;
  return typeof migration.migrationId === "string"
    && validIdentity(migration.migrationId)
    && typeof migration.fromSchemaVersion === "number"
    && validSchemaVersion(migration.fromSchemaVersion)
    && typeof migration.toSchemaVersion === "number"
    && validSchemaVersion(migration.toSchemaVersion)
    && migration.fromSchemaVersion !== migration.toSchemaVersion;
}

function authorize(
  context: SemanticServiceProviderContext,
  authorizer: PluginDataAuthorizer,
  grant: PluginDataGrant,
  input: ReadPluginDataRecordInput,
  schemaVersion?: number,
) {
  if (!validScope(input.scope) || !validIdentity(input.key)) {
    return failure("plugin-data.invalid-request", "Plugin data identity is invalid");
  }
  if (schemaVersion !== undefined && !validSchemaVersion(schemaVersion)) {
    return failure("plugin-data.invalid-schema", "Plugin data schema version is invalid");
  }
  return authorizer({
    activation: context.activation,
    grant,
    scope: input.scope,
    key: input.key,
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
  })
    ? null
    : failure("plugin-data.denied", "Plugin data access was denied");
}

function validRecord(
  value: PluginDataRecord,
  moduleId: string,
  scope: PluginDataScope,
  key: string,
  expectedSchemaVersion?: number,
  expectedRevision?: number,
): boolean {
  return value.ownerModuleId === moduleId
    && JSON.stringify(value.scope) === JSON.stringify(scope)
    && value.key === key
    && validSchemaVersion(value.schemaVersion)
    && (expectedSchemaVersion === undefined || value.schemaVersion === expectedSchemaVersion)
    && Number.isSafeInteger(value.revision)
    && value.revision >= 0
    && (expectedRevision === undefined || value.revision === expectedRevision)
    && jsonSafe(value.value)
    && Array.isArray(value.migrations)
    && value.migrations.every(validMigrationProvenance);
}

function request<Input, Output>(
  context: SemanticServiceProviderContext,
  transport: PrivateSemanticRequestTransport<Input, Output, PluginDataErrorCode>,
) {
  return createSemanticRequestAdapter({
    activation: context.activation,
    active: () => context.active,
    policy: POLICY,
    transport,
    transportError,
    cancelledError: CANCELLED,
    disposedError: DISPOSED,
  });
}

/** Trusted adapter for activation-scoped native Plugin Data commands. */
export function createPluginDataServiceProvider(
  options: PluginDataServiceProviderOptions = {},
): SemanticServiceProvider<PluginDataService> {
  const transport = options.transport ?? TAURI_TRANSPORT;
  const authorizer = options.authorize ?? DEFAULT_AUTHORIZE;
  return {
    service: pluginDataService,
    bind(context) {
      return Object.freeze({
        readRecord: request<ReadPluginDataRecordInput, PluginDataRecord | null>(context, {
          async request(envelope) {
            const denied = authorize(context, authorizer, "plugin-data.read", envelope.input);
            if (denied) return denied;
            const record = await transport.read(envelope);
            if (record !== null && !validRecord(
              record,
              context.activation.moduleId,
              envelope.input.scope,
              envelope.input.key,
            )) {
              return failure("plugin-data.transport-failed", "Plugin data response is invalid");
            }
            return { ok: true, value: record };
          },
        }),
        writeRecord: request<WritePluginDataRecordInput, PluginDataRecord>(context, {
          async request(envelope) {
            const input = envelope.input;
            const denied = authorize(
              context,
              authorizer,
              "plugin-data.write",
              input,
              input.schemaVersion,
            );
            if (denied) return denied;
            if (!validRevision(input.expectedRevision)) {
              return failure("plugin-data.invalid-revision", "Plugin data revision is invalid");
            }
            if (!jsonSafe(input.value)) {
              return failure("plugin-data.invalid-value", "Plugin data value is not JSON-safe");
            }
            const record = await transport.write(envelope);
            const nextRevision = (input.expectedRevision ?? 0) + 1;
            return validRecord(
              record,
              context.activation.moduleId,
              input.scope,
              input.key,
              input.schemaVersion,
              nextRevision,
            )
              ? { ok: true, value: record }
              : failure("plugin-data.transport-failed", "Plugin data response is invalid");
          },
        }),
        migrateRecords: request<
          MigratePluginDataRecordsInput,
          PluginDataMigrationReceipt
        >(context, {
          async request(envelope) {
            const input = envelope.input;
            if (!validIdentity(input.migrationId) || input.records.length === 0) {
              return failure("plugin-data.invalid-request", "Plugin data migration is invalid");
            }
            const identities = new Set<string>();
            for (const write of input.records) {
              const denied = authorize(
                context,
                authorizer,
                "plugin-data.migrate",
                write,
                write.toSchemaVersion,
              );
              if (denied) return denied;
              const identity = JSON.stringify([write.scope, write.key]);
              if (
                identities.has(identity)
                || !validRevision(write.expectedRevision)
                || write.expectedRevision === null
                || !validSchemaVersion(write.fromSchemaVersion)
                || write.fromSchemaVersion === write.toSchemaVersion
                || !jsonSafe(write.value)
              ) {
                return failure("plugin-data.invalid-request", "Plugin data migration is invalid");
              }
              identities.add(identity);
            }
            const receipt = await transport.migrate(envelope);
            const valid = receipt.migrationId === input.migrationId
              && typeof receipt.replayed === "boolean"
              && receipt.records.length === input.records.length
              && receipt.records.every((record, index) => {
                const write = input.records[index];
                return validRecord(
                  record,
                  context.activation.moduleId,
                  write.scope,
                  write.key,
                  write.toSchemaVersion,
                  write.expectedRevision + 1,
                ) && record.migrations.some((migration) =>
                  migration.migrationId === input.migrationId
                  && migration.fromSchemaVersion === write.fromSchemaVersion
                  && migration.toSchemaVersion === write.toSchemaVersion);
              });
            return valid
              ? { ok: true, value: receipt }
              : failure("plugin-data.transport-failed", "Plugin data response is invalid");
          },
        }),
      });
    },
  };
}
