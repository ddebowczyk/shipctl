/** Tauri-free configuration runtime entrypoint for packaged headless hosts. */
export {
  createHostConfigurationRuntime,
  createHostConfigurationServiceProvider,
} from "./runtimeService.ts";
export type {
  CreateHostConfigurationRuntimeOptions,
  HostConfigurationRuntime,
  HostConfigurationServiceProviderOptions,
} from "./runtimeService.ts";
