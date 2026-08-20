import { invoke } from "@tauri-apps/api/core";
import type { ModuleJsonValue } from "@shipctl/module-api";

/** Opaque compatibility value, read only while named imports are retired. */
export interface LegacyConfigurationValue {
  readonly value: ModuleJsonValue;
}

/**
 * Reads a raw global compatibility value. Its meaning, schema, and deletion
 * gate live in TypeScript configuration contributions, never in this port.
 */
export function readGlobalConfigurationValue(
  key: string,
): Promise<LegacyConfigurationValue | null> {
  return invoke("read_global_configuration_value", { key });
}

/** The project-scoped companion for a future owner plugin migration. */
export function readProjectConfigurationValue(
  projectId: string,
  key: string,
): Promise<LegacyConfigurationValue | null> {
  return invoke("read_project_configuration_value", { projectId, key });
}
