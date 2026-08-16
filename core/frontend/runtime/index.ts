export {
  createModuleActivationIdentity,
  SemanticServiceRegistry,
} from "./semanticServiceRuntime.ts";
export type { SemanticActivationController } from "./semanticServiceRuntime.ts";
export {
  activateStaticPluginsObserved,
  adaptShipctlModule,
  CordisStaticPluginRuntime,
  inferShipctlPluginRole,
} from "./cordis/index.ts";
export type {
  CordisStaticPluginRuntimeOptions,
  ObservedStaticPluginActivation,
  PluginActivationFailure,
} from "./cordis/index.ts";
