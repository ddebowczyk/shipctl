import type { ModuleJsonValue } from "../protocol/services";
import type { ContributionId, ModuleId } from "../protocol/panels";

/** The durable scope a configuration declaration can resolve for one owner. */
export type ConfigurationScopeKind = "global" | "project";

/** A deterministic diagnostic suitable for UI and future headless callers. */
export interface ConfigurationDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export type ConfigurationValidation<Value extends ModuleJsonValue> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly diagnostic: ConfigurationDiagnostic };

/** One pure schema transition owned by the configuration declaration. */
export interface ConfigurationMigration<Value extends ModuleJsonValue> {
  readonly fromSchemaVersion: number;
  readonly migrationId: string;
  migrate(value: ModuleJsonValue): ConfigurationValidation<Value>;
}

/**
 * A read-only compatibility source. It is used only to import an existing
 * human-editable configuration value into the owner's durable namespace.
 */
export interface LegacyConfigurationSource {
  readonly key: string;
  readonly schemaVersion: number;
  transform?(value: ModuleJsonValue): ModuleJsonValue;
}

/**
 * A configuration schema registered by an accepted activation. The owner,
 * key, defaults, validation, and migrations are TypeScript product policy;
 * the host only provides the activation-scoped durable record service.
 */
export interface ConfigurationContribution<Value extends ModuleJsonValue = ModuleJsonValue> {
  readonly id: ContributionId;
  readonly moduleId: ModuleId;
  readonly scope: ConfigurationScopeKind;
  readonly key: string;
  readonly schemaVersion: number;
  readonly defaults: Value;
  validate(value: unknown): ConfigurationValidation<Value>;
  readonly migrations?: readonly ConfigurationMigration<Value>[];
  readonly legacySource?: LegacyConfigurationSource;
}
