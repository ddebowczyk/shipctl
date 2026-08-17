import { Channel, invoke } from "@tauri-apps/api/core";

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

interface RevisionChannel {
  onmessage: ((event: ModuleRegistryRevisionEvent) => void) | null;
}

export interface ReconciliationFailureInput {
  readonly schemaVersion: 1;
  readonly registryRevision: number;
  readonly moduleId?: string;
  readonly activationId?: string;
  readonly phase: "observe" | "prepare" | "validate" | "publish" | "dispose";
  readonly code: string;
  readonly message: string;
}

export interface FrontendContributionSnapshot {
  readonly id: string;
  readonly kind: string;
}

export interface FrontendModuleRuntimeSnapshot {
  readonly moduleId: string;
  readonly artifactContentDigest?: string;
  readonly activationId?: string;
  readonly contributions: readonly FrontendContributionSnapshot[];
}

export type RuntimeModuleActivationPhase =
  | "descriptor"
  | "resolve"
  | "import"
  | "validate"
  | "bridge"
  | "activation"
  | "active";

export interface RuntimeModuleActivationSnapshot {
  readonly moduleId: string;
  readonly status: "active" | "failed";
  readonly phase: RuntimeModuleActivationPhase;
}

export interface FrontendRuntimeSnapshot {
  readonly schemaVersion: number;
  readonly registryRevision: number;
  readonly modules: readonly FrontendModuleRuntimeSnapshot[];
  readonly activationOutcomes: readonly RuntimeModuleActivationSnapshot[];
}

export interface RuntimeSnapshotReceipt {
  readonly schemaVersion: number;
  readonly instanceId: string;
  readonly registryRevision: number;
  readonly publishedAtUnixMs: number;
  readonly moduleCount: number;
  readonly contributionCount: number;
}

export function getRuntimeModuleCatalog(): Promise<RuntimeModuleCatalog> {
  return invoke("list_runtime_modules");
}

export function observeModuleRegistryRevisions(
  receive: (event: ModuleRegistryRevisionEvent) => void,
  invokeCommand: typeof invoke = invoke,
  createChannel: () => RevisionChannel = () => new Channel<ModuleRegistryRevisionEvent>(),
): Promise<() => void> {
  const channel = createChannel();
  channel.onmessage = receive;
  return invokeCommand<string>("observe_module_registry_revisions", { onRevision: channel })
    .then((observerId) => () => {
      channel.onmessage = null;
      void invokeCommand("stop_module_registry_revision_observer", { observerId });
  });
}

export function reportModuleReconciliationFailure(
  failure: ReconciliationFailureInput,
): Promise<void> {
  return invoke("report_module_reconciliation_failure", { failure });
}

export function publishModuleRuntimeSnapshot(
  snapshot: FrontendRuntimeSnapshot,
): Promise<RuntimeSnapshotReceipt> {
  return invoke("publish_module_runtime_snapshot", { snapshot });
}
