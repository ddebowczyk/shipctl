import type {
  ConfigurationService,
  PluginDataScope,
  SemanticServiceProvider,
} from "@shipctl/module-api";
import {
  createPluginDataServiceProvider,
  readGlobalConfigurationValue,
  readProjectConfigurationValue,
} from "@shipctl/core/platform";

import {
  createHostConfigurationRuntime,
  createHostConfigurationServiceProvider as createRuntimeConfigurationServiceProvider,
  type HostConfigurationRuntime,
} from "./runtimeService.ts";

function legacyValue(scope: PluginDataScope, key: string) {
  return scope.kind === "global"
    ? readGlobalConfigurationValue(key)
    : readProjectConfigurationValue(scope.projectId, key);
}

export interface HostConfigurationServiceProviderOptions {
  /** Tests and alternate desktop hosts may supply their own already-started runtime. */
  readonly runtime?: HostConfigurationRuntime;
}

let hostRuntime: HostConfigurationRuntime | null = null;

/**
 * The trusted `shipctl.host` namespace is activated by TypeScript only. No
 * plugin activation receives this admission or can select its owner identity.
 */
export function hostConfigurationRuntime(): HostConfigurationRuntime {
  hostRuntime ??= createHostConfigurationRuntime({
    pluginDataServiceProvider: createPluginDataServiceProvider(),
    legacy: { read: legacyValue },
  });
  return hostRuntime;
}

/** Desktop composition wrapper around the portable configuration provider. */
export function createHostConfigurationServiceProvider(
  options: HostConfigurationServiceProviderOptions = {},
): SemanticServiceProvider<ConfigurationService> {
  return createRuntimeConfigurationServiceProvider({
    runtime: options.runtime ?? hostConfigurationRuntime(),
  });
}

export async function disposeHostConfigurationRuntime(): Promise<void> {
  const current = hostRuntime;
  hostRuntime = null;
  await current?.dispose();
}

export type { HostConfigurationRuntime } from "./runtimeService.ts";
