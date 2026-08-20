import type {
  AcceptedPluginAdmission,
  ShipctlModule,
  ShipctlPluginDefinition,
} from "@shipctl/module-api";
import {
  getRuntimeModuleCatalog,
} from "../platform/moduleControl.ts";
import type {
  RuntimeModuleCatalog,
  RuntimeModuleDescriptor,
} from "@shipctl/core/runtime";

import {
  loadShipctlModuleArtifact,
  moduleArtifactUrl,
  ModuleArtifactLoadError,
  type LoadShipctlModuleArtifactRequest,
  type ModuleArtifactDiagnostic,
} from "./moduleArtifactLoader.ts";

export type RuntimeModuleLoadDescriptor = RuntimeModuleDescriptor;
export type RuntimeModuleLoadCatalog = RuntimeModuleCatalog;

export interface RuntimeModuleLoadFailure {
  readonly moduleId: string;
  readonly phase: "descriptor" | "resolve" | "import" | "validate" | "activation";
  readonly code: string;
  readonly message: string;
  /** Present when TypeScript rejected the artifact's product declarations. */
  readonly diagnostic?: ModuleArtifactDiagnostic;
}

export interface LoadedRuntimeModules {
  readonly catalog: RuntimeModuleLoadCatalog;
  /** Temporary compatibility view for artifacts not yet on direct activation. */
  readonly modules: readonly ShipctlModule[];
  readonly definitions: readonly ShipctlPluginDefinition[];
  readonly admissionsByModule: ReadonlyMap<string, AcceptedPluginAdmission>;
  readonly failures: readonly RuntimeModuleLoadFailure[];
}

/**
 * Host-owned artifact-import adapter. The production default remains the
 * immutable artifact loader; embedders can provide another trusted resolver
 * without exposing a loader choice to a module.
 */
export interface RuntimeModuleLoadOptions {
  /**
   * Host-platform URL adapter. The returned URL is still checked against the
   * requested immutable digest before an artifact can be imported.
   */
  readonly resolveArtifactUrl?: (artifactPath: string, contentDigest: string) => string;
  readonly importModule?: NonNullable<LoadShipctlModuleArtifactRequest["importModule"]>;
}

export async function getRuntimeModuleLoadCatalog(): Promise<RuntimeModuleLoadCatalog> {
  return getRuntimeModuleCatalog();
}

export async function loadRuntimeModules(
  catalog?: RuntimeModuleLoadCatalog,
  options: RuntimeModuleLoadOptions = {},
): Promise<LoadedRuntimeModules> {
  const runtimeCatalog = catalog ?? await getRuntimeModuleLoadCatalog();
  const resolveArtifactUrl = options.resolveArtifactUrl ?? moduleArtifactUrl;
  const modules: ShipctlModule[] = [];
  const definitions: ShipctlPluginDefinition[] = [];
  const admissionsByModule = new Map<string, AcceptedPluginAdmission>();
  const failures: RuntimeModuleLoadFailure[] = [];
  for (const descriptor of runtimeCatalog.modules) {
    try {
      if (descriptor.manifest.lifecycle !== "live") {
        throw new ModuleArtifactLoadError(
          "validate",
          `Module ${descriptor.moduleId} declares ${descriptor.manifest.lifecycle} lifecycle and cannot enter the live runtime`,
        );
      }
      const entryUrl = resolveArtifactUrl(descriptor.entryPath, descriptor.contentDigest);
      const styleUrls = descriptor.stylePaths.map((stylePath) =>
        resolveArtifactUrl(stylePath, descriptor.contentDigest));
      const loaded = await loadShipctlModuleArtifact({
        digest: descriptor.contentDigest,
        entryUrl,
        expectedModuleId: descriptor.moduleId,
        expectedVersion: descriptor.version,
        admittedApplication: descriptor.manifest.application,
        admittedMessages: descriptor.manifest.messages,
        admittedGrants: descriptor.manifest.requestedGrants,
        styleUrls,
        ...(options.importModule === undefined ? {} : { importModule: options.importModule }),
      });
      if (loaded.module !== undefined) modules.push(loaded.module);
      definitions.push(loaded.definition);
      admissionsByModule.set(descriptor.moduleId, loaded.admission);
    } catch (error) {
      failures.push({
        moduleId: descriptor.moduleId,
        phase: error instanceof ModuleArtifactLoadError
          ? error.phase === "activate" ? "activation" : error.phase
          : "validate",
        code: error instanceof ModuleArtifactLoadError
          ? error.code
          : "module.loader.invalid_artifact",
        message: error instanceof Error ? error.message : "Module artifact load failed",
        ...(error instanceof ModuleArtifactLoadError && error.diagnostic !== undefined
          ? { diagnostic: error.diagnostic }
          : {}),
      });
    }
  }
  return { catalog: runtimeCatalog, modules, definitions, admissionsByModule, failures };
}
