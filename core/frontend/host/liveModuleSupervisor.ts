// Compatibility export for host callers while lifecycle ownership lives in
// the React-free runtime capability.
export { LiveModuleSupervisor } from "@shipctl/core/runtime";
export type {
  LiveModuleFamily,
  LiveModuleSupervisorOptions,
  LoadedRuntimeModules,
  OpenRuntimeMessageBridge,
  RuntimeMessageBridge,
} from "@shipctl/core/runtime";
