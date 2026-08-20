import { defineSemanticService } from "./semanticServices.ts";
import type { PluginDataRecord } from "./pluginData.ts";
import type { ModuleJsonValue } from "./services.ts";
import type { SemanticRequestOperation } from "./semanticServices.ts";

/** Public host settings that may be addressed by a runtime operation. */
export const HOST_CONFIGURATION_KEYS = [
  "runtime",
  "editor",
  "projects",
  "keybindings",
  "terminal",
  "sidebar",
] as const;

export type HostConfigurationKey = (typeof HOST_CONFIGURATION_KEYS)[number];

export function isHostConfigurationKey(value: unknown): value is HostConfigurationKey {
  return typeof value === "string"
    && (HOST_CONFIGURATION_KEYS as readonly string[]).includes(value);
}

export interface InspectConfigurationInput {
  readonly key: HostConfigurationKey;
}

export interface ResolveConfigurationInput {
  readonly key: HostConfigurationKey;
}

export interface UpdateConfigurationInput {
  readonly key: HostConfigurationKey;
  readonly value: ModuleJsonValue;
}

/** A data-only projection of the TypeScript configuration runtime's inspection. */
export type HostConfigurationInspection =
  | {
      readonly key: HostConfigurationKey;
      readonly state: "stored" | "default" | "legacy" | "migration";
      readonly value: ModuleJsonValue;
      readonly record?: PluginDataRecord;
    }
  | {
      readonly key: HostConfigurationKey;
      readonly state: "invalid";
      readonly diagnostic: {
        readonly code: string;
        readonly message: string;
        readonly path?: string;
      };
      readonly record?: PluginDataRecord;
    };

export interface HostConfigurationResolution {
  readonly key: HostConfigurationKey;
  readonly record: PluginDataRecord;
  readonly value: ModuleJsonValue;
  readonly changed: boolean;
}

export type ConfigurationServiceErrorCode =
  | "configuration.activation-disposed"
  | "configuration.cancelled"
  | "configuration.failed";

/**
 * Semantic access to the trusted host configuration runtime. Product schema
 * and persistence semantics remain TypeScript-owned; consumers receive only
 * JSON-safe inspection and resolution projections.
 */
export interface ConfigurationService {
  readonly inspectConfiguration: SemanticRequestOperation<
    InspectConfigurationInput,
    HostConfigurationInspection,
    ConfigurationServiceErrorCode
  >;
  readonly resolveConfiguration: SemanticRequestOperation<
    ResolveConfigurationInput,
    HostConfigurationResolution,
    ConfigurationServiceErrorCode
  >;
  readonly updateConfiguration: SemanticRequestOperation<
    UpdateConfigurationInput,
    HostConfigurationResolution,
    ConfigurationServiceErrorCode
  >;
}

export const configurationService = defineSemanticService<ConfigurationService>(
  "shipctl.configuration",
  1,
);
