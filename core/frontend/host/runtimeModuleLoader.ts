import type { ShipctlModule, ShipctlPluginDefinition } from "@shipctl/module-api";
import {
  getRuntimeModuleCatalog,
  type RuntimeModuleCatalog,
  type RuntimeModuleDescriptor,
} from "../platform/moduleControl.ts";

import {
  loadShipctlModuleArtifact,
  moduleArtifactUrl,
  ModuleArtifactLoadError,
} from "./moduleArtifactLoader.ts";

export type RuntimeModuleLoadDescriptor = RuntimeModuleDescriptor;
export type RuntimeModuleLoadCatalog = RuntimeModuleCatalog;

export interface RuntimeModuleLoadFailure {
  readonly moduleId: string;
  readonly phase: "descriptor" | "resolve" | "import" | "validate" | "activation";
  readonly code: string;
  readonly message: string;
}

export interface LoadedRuntimeModules {
  readonly catalog: RuntimeModuleLoadCatalog;
  readonly modules: readonly ShipctlModule[];
  readonly definitions: readonly ShipctlPluginDefinition[];
  readonly failures: readonly RuntimeModuleLoadFailure[];
}

export async function getRuntimeModuleLoadCatalog(): Promise<RuntimeModuleLoadCatalog> {
  return getRuntimeModuleCatalog();
}

export async function loadRuntimeModules(
  catalog?: RuntimeModuleLoadCatalog,
): Promise<LoadedRuntimeModules> {
  const runtimeCatalog = catalog ?? await getRuntimeModuleLoadCatalog();
  const modules: ShipctlModule[] = [];
  const definitions: ShipctlPluginDefinition[] = [];
  const failures: RuntimeModuleLoadFailure[] = [];
  for (const descriptor of runtimeCatalog.modules) {
    try {
      if (descriptor.manifest.lifecycle !== "live") {
        throw new ModuleArtifactLoadError(
          "validate",
          `Module ${descriptor.moduleId} declares ${descriptor.manifest.lifecycle} lifecycle and cannot enter the live runtime`,
        );
      }
      const entryUrl = moduleArtifactUrl(descriptor.entryPath, descriptor.contentDigest);
      const styleUrls = descriptor.stylePaths.map((stylePath) =>
        moduleArtifactUrl(stylePath, descriptor.contentDigest));
      const loaded = await loadShipctlModuleArtifact({
        digest: descriptor.contentDigest,
        entryUrl,
        expectedModuleId: descriptor.moduleId,
        expectedVersion: descriptor.version,
        admittedApplication: descriptor.manifest.application,
        admittedMessages: descriptor.manifest.messages,
        admittedGrants: descriptor.manifest.requestedGrants,
        styleUrls,
      });
      modules.push(loaded.module);
      definitions.push(loaded.definition);
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
      });
    }
  }
  return { catalog: runtimeCatalog, modules, definitions, failures };
}
