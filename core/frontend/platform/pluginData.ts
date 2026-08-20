import { invoke } from "@tauri-apps/api/core";
import type { PluginDataService, SemanticServiceProvider } from "@shipctl/module-api";

import {
  createPluginDataServiceProviderWithTransport,
  type PluginDataServiceProviderOptions,
  type PluginDataTransport,
} from "./pluginDataAdapter.ts";

export type {
  PluginDataNativeRequest,
  PluginDataServiceProviderOptions,
  PluginDataTransport,
} from "./pluginDataAdapter.ts";

const COMMANDS = {
  read: "read_plugin_data_record",
  write: "write_plugin_data_record",
  migrate: "migrate_plugin_data_records",
} as const;

const TAURI_TRANSPORT: PluginDataTransport = {
  read: (request) => invoke(COMMANDS.read, { request }),
  write: (request) => invoke(COMMANDS.write, { request }),
  migrate: (request) => invoke(COMMANDS.migrate, { request }),
};

/**
 * Trusted adapter for activation-scoped native Plugin Data commands.
 *
 * The reusable authorization and response-validation layer stays independent
 * of Tauri so packaged headless hosts can provide the same service through
 * their own private transport.
 */
export function createPluginDataServiceProvider(
  options: PluginDataServiceProviderOptions = {},
): SemanticServiceProvider<PluginDataService> {
  return createPluginDataServiceProviderWithTransport(options.transport ?? TAURI_TRANSPORT);
}
