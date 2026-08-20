import {
  pluginDataService,
  type MigratePluginDataRecordsInput,
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

export interface PluginDataTransport {
  read(
    request: PluginDataNativeRequest<ReadPluginDataRecordInput>,
  ): Promise<PluginDataRecord | null>;
  write(
    request: PluginDataNativeRequest<WritePluginDataRecordInput>,
  ): Promise<PluginDataRecord>;
  migrate(
    request: PluginDataNativeRequest<MigratePluginDataRecordsInput>,
  ): Promise<PluginDataMigrationReceipt>;
}

/**
 * Private native framing for this one resource. The activation's effective
 * plugin-data grants are bound by the TypeScript runtime before storage sees
 * a request; native storage only enforces this generic vocabulary.
 */
export interface PluginDataNativeRequest<Input> {
  readonly activation: {
    readonly moduleId: string;
    readonly activationId: string;
    readonly effectiveGrants: readonly PluginDataGrant[];
  };
  readonly correlationId: PrivateSemanticRequestEnvelope<Input>["correlationId"];
  readonly input: Input;
}

export interface PluginDataServiceProviderOptions {
  readonly transport?: PluginDataTransport;
}

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

const PLUGIN_DATA_GRANTS = new Set<PluginDataGrant>([
  "plugin-data.read",
  "plugin-data.write",
  "plugin-data.migrate",
]);

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
  const admission = context.acceptedAdmission;
  return admission !== null
    && admission.artifact.moduleId === context.activation.moduleId
    && admission.effectiveGrants.includes(grant)
    ? null
    : failure("plugin-data.denied", "Plugin data access was denied");
}

function isPluginDataGrant(value: string): value is PluginDataGrant {
  return PLUGIN_DATA_GRANTS.has(value as PluginDataGrant);
}

function nativeRequest<Input>(
  context: SemanticServiceProviderContext,
  envelope: PrivateSemanticRequestEnvelope<Input>,
): PluginDataNativeRequest<Input> {
  const admission = context.acceptedAdmission;
  return {
    activation: {
      moduleId: context.activation.moduleId,
      activationId: context.activation.activationId,
      effectiveGrants: admission === null
        ? []
        : admission.effectiveGrants.filter(isPluginDataGrant),
    },
    correlationId: envelope.correlationId,
    input: envelope.input,
  };
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

/**
 * Trusted, Tauri-free adapter for activation-scoped Plugin Data commands.
 * Callers must supply their own process transport.
 */
export function createPluginDataServiceProviderWithTransport(
  transport: PluginDataTransport,
): SemanticServiceProvider<PluginDataService> {
  return {
    service: pluginDataService,
    bind(context) {
      return Object.freeze({
        readRecord: request<ReadPluginDataRecordInput, PluginDataRecord | null>(context, {
          async request(envelope) {
            const denied = authorize(context, "plugin-data.read", envelope.input);
            if (denied) return denied;
            const record = await transport.read(nativeRequest(context, envelope));
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
            const record = await transport.write(nativeRequest(context, envelope));
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
            const receipt = await transport.migrate(nativeRequest(context, envelope));
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
