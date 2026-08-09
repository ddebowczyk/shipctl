import { invoke } from "@tauri-apps/api/core";
import type { MessageDeclarations, ShipctlModule } from "@shipctl/module-api";
import { parseMessageDeclarations } from "@shipctl/module-api";

import {
  loadShipctlModuleArtifact,
  moduleArtifactUrl,
  ModuleArtifactLoadError,
} from "./moduleArtifactLoader.ts";
import { messageDeclarations } from "./moduleMessageContext.ts";

export interface StartupModuleDescriptor {
  readonly schemaVersion: 1;
  readonly moduleId: string;
  readonly version: string;
  readonly contentDigest: string;
  readonly entryPath: string;
  readonly manifest: {
    readonly messages: unknown;
    readonly [key: string]: unknown;
  };
  readonly capabilities: {
    readonly definitions: readonly unknown[];
    readonly [key: string]: unknown;
  };
}

export interface StartupModuleCatalog {
  readonly schemaVersion: 1;
  readonly registryRevision: number;
  readonly modules: readonly StartupModuleDescriptor[];
}

export interface RestartBoundModuleFailure {
  readonly moduleId: string;
  readonly phase: "descriptor" | "resolve" | "import" | "validate" | "activation";
  readonly code: string;
  readonly message: string;
}

export interface RestartBoundModules {
  readonly catalog: StartupModuleCatalog;
  readonly modules: readonly ShipctlModule[];
  readonly failures: readonly RestartBoundModuleFailure[];
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return value;
}

function sameDeclarations(left: MessageDeclarations, right: MessageDeclarations): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

export async function getStartupModuleCatalog(): Promise<StartupModuleCatalog> {
  return invoke<StartupModuleCatalog>("list_startup_modules");
}

export async function loadRestartBoundModules(
  catalog?: StartupModuleCatalog,
): Promise<RestartBoundModules> {
  const startupCatalog = catalog ?? await getStartupModuleCatalog();
  const modules: ShipctlModule[] = [];
  const failures: RestartBoundModuleFailure[] = [];
  for (const descriptor of startupCatalog.modules) {
    try {
      const admittedMessages = parseMessageDeclarations(descriptor.manifest.messages);
      const entryUrl = moduleArtifactUrl(descriptor.entryPath, descriptor.contentDigest);
      const loaded = await loadShipctlModuleArtifact({
        digest: descriptor.contentDigest,
        entryUrl,
        expectedModuleId: descriptor.moduleId,
        expectedVersion: descriptor.version,
      });
      const runtimeMessages = parseMessageDeclarations(messageDeclarations(loaded.module));
      if (!sameDeclarations(admittedMessages, runtimeMessages)) {
        throw new ModuleArtifactLoadError(
          "validate",
          "Runtime message declarations do not match the admitted manifest",
        );
      }
      modules.push(loaded.module);
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
  return { catalog: startupCatalog, modules, failures };
}
