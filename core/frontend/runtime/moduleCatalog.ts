/**
 * Renderer-neutral description of the artifact graph the runtime is asked to
 * reconcile. Native transports implement this protocol; they do not own its
 * lifecycle semantics.
 */
export interface RuntimeModuleDescriptor {
  readonly schemaVersion: 1;
  readonly moduleId: string;
  readonly version: string;
  readonly contentDigest: string;
  readonly entryPath: string;
  readonly stylePaths: readonly string[];
  readonly manifest: {
    readonly schemaVersion: number;
    readonly application?: unknown;
    readonly lifecycle: "live" | "drain_required" | "restart_required" | "unsupported";
    readonly messages: unknown;
    readonly requestedGrants: unknown;
    readonly [key: string]: unknown;
  };
  readonly capabilities: {
    readonly definitions: readonly unknown[];
    readonly [key: string]: unknown;
  };
}

export interface RuntimeModuleCatalog {
  readonly schemaVersion: 1;
  readonly registryRevision: number;
  readonly modules: readonly RuntimeModuleDescriptor[];
  readonly lastApplied?: AppliedRuntimeModuleCatalog;
}

export interface AppliedRuntimeModuleCatalog {
  readonly registryRevision: number;
  readonly modules: readonly RuntimeModuleDescriptor[];
}

export interface ModuleRegistryRevisionEvent {
  readonly schemaVersion: 1;
  readonly registryRevision: number;
}
