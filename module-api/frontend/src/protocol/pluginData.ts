import { defineSemanticService } from "./semanticServices.ts";
import type { ModuleJsonValue } from "./services";
import type { SemanticRequestOperation } from "./semanticServices";

declare const pluginDataRevisionBrand: unique symbol;

/** JavaScript-safe opaque revision. Zero identifies a read-only legacy record. */
export type PluginDataRevision = number & {
  readonly [pluginDataRevisionBrand]: true;
};

export type PluginDataGrant =
  | "plugin-data.read"
  | "plugin-data.write"
  | "plugin-data.migrate";

export type PluginDataScope =
  | { readonly kind: "global" }
  | { readonly kind: "project"; readonly projectId: string };

export interface PluginDataMigrationProvenance {
  readonly migrationId: string;
  readonly fromSchemaVersion: number;
  readonly toSchemaVersion: number;
}

export interface PluginDataRecord {
  /** Derived from the activation. Callers never select another namespace. */
  readonly ownerModuleId: string;
  readonly scope: PluginDataScope;
  readonly key: string;
  readonly schemaVersion: number;
  readonly revision: PluginDataRevision;
  readonly value: ModuleJsonValue;
  readonly migrations: readonly PluginDataMigrationProvenance[];
}

export interface ReadPluginDataRecordInput {
  readonly scope: PluginDataScope;
  readonly key: string;
}

export interface WritePluginDataRecordInput extends ReadPluginDataRecordInput {
  /** Null creates only. A revision replaces only. */
  readonly expectedRevision: PluginDataRevision | null;
  readonly schemaVersion: number;
  readonly value: ModuleJsonValue;
}

export interface PluginDataMigrationWrite extends ReadPluginDataRecordInput {
  readonly expectedRevision: PluginDataRevision;
  readonly fromSchemaVersion: number;
  readonly toSchemaVersion: number;
  readonly value: ModuleJsonValue;
}

/** All record changes in one migration commit or none do. */
export interface MigratePluginDataRecordsInput {
  readonly migrationId: string;
  readonly records: readonly PluginDataMigrationWrite[];
}

export interface PluginDataMigrationReceipt {
  readonly migrationId: string;
  readonly records: readonly PluginDataRecord[];
  /** A replay returns the original committed records without new revisions. */
  readonly replayed: boolean;
}

export type PluginDataErrorCode =
  | "plugin-data.transport-failed"
  | "plugin-data.denied"
  | "plugin-data.invalid-request"
  | "plugin-data.invalid-project"
  | "plugin-data.invalid-schema"
  | "plugin-data.invalid-value"
  | "plugin-data.invalid-revision"
  | "plugin-data.not-found"
  | "plugin-data.conflict"
  | "plugin-data.storage-failed"
  | "plugin-data.unavailable"
  | "plugin-data.cancelled"
  | "plugin-data.activation-disposed";

export interface PluginDataService {
  readonly readRecord: SemanticRequestOperation<
    ReadPluginDataRecordInput,
    PluginDataRecord | null,
    PluginDataErrorCode
  >;
  readonly writeRecord: SemanticRequestOperation<
    WritePluginDataRecordInput,
    PluginDataRecord,
    PluginDataErrorCode
  >;
  readonly migrateRecords: SemanticRequestOperation<
    MigratePluginDataRecordsInput,
    PluginDataMigrationReceipt,
    PluginDataErrorCode
  >;
}

export const pluginDataService = defineSemanticService<PluginDataService>(
  "shipctl.plugin-data",
  1,
);
