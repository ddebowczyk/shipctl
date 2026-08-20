// Compatibility export for host callers while runtime lifecycle ownership is
// relocated. New runtime code imports this controller from the runtime API.
export {
  AcceptedWorkspaceCatalogController,
} from "@shipctl/core/runtime";
export type {
  AcceptedWorkspaceCatalogControllerOptions,
  WorkspaceCatalogSynchronizationFailure,
} from "@shipctl/core/runtime";
