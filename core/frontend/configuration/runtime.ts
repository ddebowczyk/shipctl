import type {
  ConfigurationContribution,
  ConfigurationDiagnostic,
  ConfigurationMigration,
  ConfigurationValidation,
  ModuleJsonValue,
  PluginDataRecord,
  PluginDataScope,
  PluginDataService,
} from "@shipctl/module-api";

export interface LegacyConfigurationValue {
  readonly value: ModuleJsonValue;
}

/** A read-only import source; durable writes always use plugin-data. */
export interface LegacyConfigurationReader {
  read(scope: PluginDataScope, key: string): Promise<LegacyConfigurationValue | null>;
}

export type ConfigurationInspection<Value extends ModuleJsonValue> =
  | {
      readonly state: "stored";
      readonly contribution: ConfigurationContribution<Value>;
      readonly scope: PluginDataScope;
      readonly record: PluginDataRecord;
      readonly value: Value;
    }
  | {
      readonly state: "default";
      readonly contribution: ConfigurationContribution<Value>;
      readonly scope: PluginDataScope;
      readonly value: Value;
    }
  | {
      readonly state: "legacy";
      readonly contribution: ConfigurationContribution<Value>;
      readonly scope: PluginDataScope;
      readonly legacyValue: ModuleJsonValue;
      readonly value: Value;
      readonly migration: ConfigurationMigration<Value> | null;
    }
  | {
      readonly state: "migration";
      readonly contribution: ConfigurationContribution<Value>;
      readonly scope: PluginDataScope;
      readonly record: PluginDataRecord;
      readonly value: Value;
      readonly migration: ConfigurationMigration<Value>;
    }
  | {
      readonly state: "invalid";
      readonly contribution: ConfigurationContribution<Value>;
      readonly scope: PluginDataScope;
      readonly diagnostic: ConfigurationDiagnostic;
      readonly record?: PluginDataRecord;
    };

export interface ConfigurationResolution<Value extends ModuleJsonValue> {
  readonly contribution: ConfigurationContribution<Value>;
  readonly scope: PluginDataScope;
  readonly record: PluginDataRecord;
  readonly value: Value;
  readonly changed: boolean;
}

/** A configuration problem is structured enough for a UI or headless caller. */
export class ConfigurationRuntimeError extends Error {
  readonly code: string;
  readonly diagnostic: ConfigurationDiagnostic | undefined;

  constructor(
    code: string,
    message: string,
    diagnostic?: ConfigurationDiagnostic,
  ) {
    super(message);
    this.name = "ConfigurationRuntimeError";
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

export interface ConfigurationRuntimeOptions {
  /** The activation whose plugin-data binding owns every resolved record. */
  readonly ownerModuleId: string;
  readonly contributions: readonly ConfigurationContribution[];
  readonly pluginData: PluginDataService;
  readonly legacy: LegacyConfigurationReader;
}

function key(scope: PluginDataScope, recordKey: string): string {
  return `${scope.kind}:${scope.kind === "project" ? scope.projectId : ""}:${recordKey}`;
}

function invalid<Value extends ModuleJsonValue>(
  contribution: ConfigurationContribution<Value>,
  scope: PluginDataScope,
  code: string,
  message: string,
  path?: string,
  record?: PluginDataRecord,
): ConfigurationInspection<Value> {
  return {
    state: "invalid",
    contribution,
    scope,
    diagnostic: path === undefined ? { code, message } : { code, message, path },
    ...(record === undefined ? {} : { record }),
  };
}

/**
 * Headless TypeScript configuration semantics. Callers inspect and validate
 * first; only `apply`, `resolve`, and `update` touch the durable record.
 */
export class ConfigurationRuntime {
  readonly #contributions: ReadonlyMap<string, ConfigurationContribution>;
  readonly #pluginData: PluginDataService;
  readonly #legacy: LegacyConfigurationReader;

  constructor(options: ConfigurationRuntimeOptions) {
    if (!options.ownerModuleId.trim()) {
      throw new Error("Configuration runtime owner module ID must be non-empty");
    }
    const contributions = new Map<string, ConfigurationContribution>();
    for (const contribution of options.contributions) {
      if (!contribution.id || !contribution.moduleId || !contribution.key.trim()) {
        throw new Error("Configuration contribution identity must be non-empty");
      }
      if (contribution.moduleId !== options.ownerModuleId) {
        throw new Error(
          `Configuration ${contribution.id} belongs to ${contribution.moduleId}, not ${options.ownerModuleId}`,
        );
      }
      if (!Number.isSafeInteger(contribution.schemaVersion) || contribution.schemaVersion < 1) {
        throw new Error(`Configuration ${contribution.id} has an invalid schema version`);
      }
      const defaults = contribution.validate(contribution.defaults);
      if (!defaults.ok) {
        throw new Error(`Configuration ${contribution.id} has invalid defaults: ${defaults.diagnostic.message}`);
      }
      for (const migration of contribution.migrations ?? []) {
        if (
          !Number.isSafeInteger(migration.fromSchemaVersion)
          || migration.fromSchemaVersion < 1
          || migration.fromSchemaVersion >= contribution.schemaVersion
          || !migration.migrationId.trim()
        ) {
          throw new Error(`Configuration ${contribution.id} has an invalid migration`);
        }
      }
      const contributionKey = key(
        contribution.scope === "global"
          ? { kind: "global" }
          : { kind: "project", projectId: "<project>" },
        contribution.key,
      );
      if (contributions.has(contributionKey)) {
        throw new Error(`Duplicate configuration contribution: ${contributionKey}`);
      }
      contributions.set(contributionKey, contribution);
    }
    this.#contributions = contributions;
    this.#pluginData = options.pluginData;
    this.#legacy = options.legacy;
  }

  contribution<Value extends ModuleJsonValue>(
    scope: PluginDataScope,
    recordKey: string,
  ): ConfigurationContribution<Value> {
    const contributionKey = key(
      scope.kind === "global" ? scope : { kind: "project", projectId: "<project>" },
      recordKey,
    );
    const contribution = this.#contributions.get(contributionKey);
    if (contribution === undefined) {
      throw new ConfigurationRuntimeError(
        "configuration.unknown",
        `No accepted configuration owns ${scope.kind}:${recordKey}.`,
      );
    }
    return contribution as ConfigurationContribution<Value>;
  }

  validate<Value extends ModuleJsonValue>(
    contribution: ConfigurationContribution<Value>,
    value: unknown,
  ): ConfigurationValidation<Value> {
    return contribution.validate(value);
  }

  async inspect<Value extends ModuleJsonValue>(
    contribution: ConfigurationContribution<Value>,
    scope: PluginDataScope,
  ): Promise<ConfigurationInspection<Value>> {
    this.#assertScope(contribution, scope);
    const record = await this.#read(scope, contribution.key);
    if (record !== null) return this.#inspectRecord(contribution, scope, record);

    const source = contribution.legacySource;
    if (source === undefined) {
      return { state: "default", contribution, scope, value: contribution.defaults };
    }

    let legacy: LegacyConfigurationValue | null;
    try {
      legacy = await this.#legacy.read(scope, source.key);
    } catch (error) {
      return invalid(
        contribution,
        scope,
        "configuration.legacy-unavailable",
        error instanceof Error ? error.message : "Legacy configuration could not be read.",
      );
    }
    if (legacy === null) {
      return { state: "default", contribution, scope, value: contribution.defaults };
    }

    let legacyValue: ModuleJsonValue;
    try {
      legacyValue = source.transform === undefined ? legacy.value : source.transform(legacy.value);
    } catch (error) {
      return invalid(
        contribution,
        scope,
        "configuration.legacy-transform-failed",
        error instanceof Error ? error.message : "Legacy configuration could not be transformed.",
      );
    }
    if (source.schemaVersion === contribution.schemaVersion) {
      const validation = contribution.validate(legacyValue);
      return validation.ok
        ? { state: "legacy", contribution, scope, legacyValue, value: validation.value, migration: null }
        : { state: "invalid", contribution, scope, diagnostic: validation.diagnostic };
    }
    if (source.schemaVersion > contribution.schemaVersion) {
      return invalid(
        contribution,
        scope,
        "configuration.unsupported-schema",
        `Legacy configuration schema ${source.schemaVersion} is newer than ${contribution.schemaVersion}.`,
      );
    }
    const migration = this.#migration(contribution, source.schemaVersion);
    if (migration === undefined) {
      return invalid(
        contribution,
        scope,
        "configuration.migration-missing",
        `Configuration ${contribution.id} has no migration from schema ${source.schemaVersion}.`,
      );
    }
    const migrated = migration.migrate(legacyValue);
    if (!migrated.ok) return { state: "invalid", contribution, scope, diagnostic: migrated.diagnostic };
    const validation = contribution.validate(migrated.value);
    return validation.ok
      ? { state: "legacy", contribution, scope, legacyValue, value: validation.value, migration }
      : { state: "invalid", contribution, scope, diagnostic: validation.diagnostic };
  }

  async apply<Value extends ModuleJsonValue>(
    inspection: ConfigurationInspection<Value>,
  ): Promise<ConfigurationResolution<Value>> {
    switch (inspection.state) {
      case "invalid":
        throw new ConfigurationRuntimeError(
          inspection.diagnostic.code,
          `${inspection.contribution.id}: ${inspection.diagnostic.message}`,
          inspection.diagnostic,
        );
      case "stored":
        return this.#resolution(inspection.contribution, inspection.scope, inspection.record, inspection.value, false);
      case "default": {
        const record = await this.#write(
          inspection.scope,
          inspection.contribution.key,
          null,
          inspection.contribution.schemaVersion,
          inspection.value,
        );
        return this.#resolution(inspection.contribution, inspection.scope, record, inspection.value, true);
      }
      case "legacy": {
        const sourceSchemaVersion = inspection.contribution.legacySource?.schemaVersion;
        if (sourceSchemaVersion === undefined) {
          throw new ConfigurationRuntimeError("configuration.internal", "Legacy inspection has no source schema.");
        }
        const seeded = await this.#write(
          inspection.scope,
          inspection.contribution.key,
          null,
          sourceSchemaVersion,
          inspection.migration === null ? inspection.value : inspection.legacyValue,
        );
        if (inspection.migration === null) {
          return this.#resolution(inspection.contribution, inspection.scope, seeded, inspection.value, true);
        }
        return this.#migrate(
          inspection.contribution,
          inspection.scope,
          seeded,
          inspection.value,
          inspection.migration,
        );
      }
      case "migration":
        return this.#migrate(
          inspection.contribution,
          inspection.scope,
          inspection.record,
          inspection.value,
          inspection.migration,
        );
    }
  }

  async resolve<Value extends ModuleJsonValue>(
    contribution: ConfigurationContribution<Value>,
    scope: PluginDataScope,
  ): Promise<ConfigurationResolution<Value>> {
    return this.apply(await this.inspect(contribution, scope));
  }

  async update<Value extends ModuleJsonValue>(
    contribution: ConfigurationContribution<Value>,
    scope: PluginDataScope,
    value: unknown,
  ): Promise<ConfigurationResolution<Value>> {
    const validation = contribution.validate(value);
    if (!validation.ok) {
      throw new ConfigurationRuntimeError(
        validation.diagnostic.code,
        `${contribution.id}: ${validation.diagnostic.message}`,
        validation.diagnostic,
      );
    }
    const current = await this.resolve(contribution, scope);
    const record = await this.#write(
      scope,
      contribution.key,
      current.record.revision,
      contribution.schemaVersion,
      validation.value,
    );
    return this.#resolution(contribution, scope, record, validation.value, true);
  }

  #assertScope<Value extends ModuleJsonValue>(
    contribution: ConfigurationContribution<Value>,
    scope: PluginDataScope,
  ): void {
    if (contribution.scope !== scope.kind) {
      throw new ConfigurationRuntimeError(
        "configuration.scope-mismatch",
        `Configuration ${contribution.id} requires ${contribution.scope} scope.`,
      );
    }
  }

  #migration<Value extends ModuleJsonValue>(
    contribution: ConfigurationContribution<Value>,
    fromSchemaVersion: number,
  ): ConfigurationMigration<Value> | undefined {
    return contribution.migrations?.find((migration) => (
      migration.fromSchemaVersion === fromSchemaVersion
    ));
  }

  #inspectRecord<Value extends ModuleJsonValue>(
    contribution: ConfigurationContribution<Value>,
    scope: PluginDataScope,
    record: PluginDataRecord,
  ): ConfigurationInspection<Value> {
    if (record.schemaVersion === contribution.schemaVersion) {
      const validation = contribution.validate(record.value);
      return validation.ok
        ? { state: "stored", contribution, scope, record, value: validation.value }
        : { state: "invalid", contribution, scope, record, diagnostic: validation.diagnostic };
    }
    if (record.schemaVersion > contribution.schemaVersion) {
      return invalid(
        contribution,
        scope,
        "configuration.unsupported-schema",
        `Configuration ${contribution.id} record schema ${record.schemaVersion} is newer than ${contribution.schemaVersion}.`,
        undefined,
        record,
      );
    }
    const migration = this.#migration(contribution, record.schemaVersion);
    if (migration === undefined) {
      return invalid(
        contribution,
        scope,
        "configuration.migration-missing",
        `Configuration ${contribution.id} has no migration from schema ${record.schemaVersion}.`,
        undefined,
        record,
      );
    }
    const migrated = migration.migrate(record.value);
    if (!migrated.ok) {
      return { state: "invalid", contribution, scope, record, diagnostic: migrated.diagnostic };
    }
    const validation = contribution.validate(migrated.value);
    return validation.ok
      ? { state: "migration", contribution, scope, record, value: validation.value, migration }
      : { state: "invalid", contribution, scope, record, diagnostic: validation.diagnostic };
  }

  async #read(scope: PluginDataScope, recordKey: string): Promise<PluginDataRecord | null> {
    const outcome = await this.#pluginData.readRecord.execute({ scope, key: recordKey });
    if (outcome.result.ok) return outcome.result.value;
    throw new ConfigurationRuntimeError(outcome.result.error.code, outcome.result.error.message);
  }

  async #write(
    scope: PluginDataScope,
    recordKey: string,
    expectedRevision: PluginDataRecord["revision"] | null,
    schemaVersion: number,
    value: ModuleJsonValue,
  ): Promise<PluginDataRecord> {
    const outcome = await this.#pluginData.writeRecord.execute({
      scope,
      key: recordKey,
      expectedRevision,
      schemaVersion,
      value,
    });
    if (outcome.result.ok) return outcome.result.value;
    throw new ConfigurationRuntimeError(outcome.result.error.code, outcome.result.error.message);
  }

  async #migrate<Value extends ModuleJsonValue>(
    contribution: ConfigurationContribution<Value>,
    scope: PluginDataScope,
    record: PluginDataRecord,
    value: Value,
    migration: ConfigurationMigration<Value>,
  ): Promise<ConfigurationResolution<Value>> {
    const outcome = await this.#pluginData.migrateRecords.execute({
      migrationId: migration.migrationId,
      records: [{
        scope,
        key: contribution.key,
        expectedRevision: record.revision,
        fromSchemaVersion: record.schemaVersion,
        toSchemaVersion: contribution.schemaVersion,
        value,
      }],
    });
    if (!outcome.result.ok) {
      throw new ConfigurationRuntimeError(outcome.result.error.code, outcome.result.error.message);
    }
    const migrated = outcome.result.value.records[0];
    if (migrated === undefined) {
      throw new ConfigurationRuntimeError("configuration.migration-empty", "Migration returned no durable record.");
    }
    return this.#resolution(contribution, scope, migrated, value, true);
  }

  #resolution<Value extends ModuleJsonValue>(
    contribution: ConfigurationContribution<Value>,
    scope: PluginDataScope,
    record: PluginDataRecord,
    value: Value,
    changed: boolean,
  ): ConfigurationResolution<Value> {
    return { contribution, scope, record, value, changed };
  }
}
