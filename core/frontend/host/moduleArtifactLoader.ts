import { convertFileSrc } from "@tauri-apps/api/core";
import * as React from "react";

/** The contract for the one generic, once-built frontend artifact loader. */
export const MODULE_ARTIFACT_LOADER_SCHEMA_VERSION = 1;

export type ModuleArtifactLoadPhase = "resolve" | "import" | "validate" | "activate";

export interface ModuleArtifactHost {
  readonly react: typeof React;
}

export interface ModuleArtifactRuntime {
  readonly marker: string;
  readonly react: typeof React;
}

interface ModuleArtifactNamespace {
  readonly runtimeMarker?: unknown;
  activate?(host: ModuleArtifactHost): ModuleArtifactRuntime;
}

export interface LoadModuleArtifactRequest {
  readonly digest: string;
  readonly entryUrl: string;
  readonly importModule?: (url: string) => Promise<ModuleArtifactNamespace>;
}

export interface LoadedModuleArtifact {
  readonly digest: string;
  readonly entryUrl: string;
  readonly marker: string;
  readonly runtime: ModuleArtifactRuntime;
}

export class ModuleArtifactLoadError extends Error {
  readonly code: string;
  readonly phase: ModuleArtifactLoadPhase;
  readonly cause: unknown;

  constructor(
    phase: ModuleArtifactLoadPhase,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "ModuleArtifactLoadError";
    this.phase = phase;
    this.cause = cause;
    this.code = phase === "validate"
      ? "module.loader.invalid_artifact"
      : `module.loader.${phase}_failed`;
  }
}

function decodedUrl(entryUrl: string): string {
  try {
    return decodeURIComponent(entryUrl);
  } catch (error) {
    throw new ModuleArtifactLoadError(
      "resolve",
      "The module artifact URL cannot be decoded",
      error,
    );
  }
}

/**
 * Keep the identity check at the generic host boundary: a loader never accepts
 * an artifact whose URL is not inside the exact immutable digest directory.
 */
export function assertDigestQualifiedArtifactUrl(entryUrl: string, digest: string): void {
  if (!/^[a-f0-9]{64}$/i.test(digest)) {
    throw new ModuleArtifactLoadError("resolve", "Module artifact digest must be a SHA-256 hex value");
  }
  const url = decodedUrl(entryUrl);
  if (!url.includes(`/${digest}/`)) {
    throw new ModuleArtifactLoadError(
      "resolve",
      "Module artifact URL is not qualified by its requested digest",
    );
  }
}

/**
 * Converts a backend-approved absolute entry path to Tauri's production asset
 * protocol. The caller receives no API for arbitrary paths; the registry will
 * supply only entries below the instance's immutable artifact root.
 */
export function moduleArtifactUrl(
  entryPath: string,
  digest: string,
  toUrl: (path: string) => string = convertFileSrc,
): string {
  const entryUrl = toUrl(entryPath);
  assertDigestQualifiedArtifactUrl(entryUrl, digest);
  return entryUrl;
}

export async function loadModuleArtifact({
  digest,
  entryUrl,
  importModule = (url) => import(/* @vite-ignore */ url),
}: LoadModuleArtifactRequest): Promise<LoadedModuleArtifact> {
  assertDigestQualifiedArtifactUrl(entryUrl, digest);

  let namespace: ModuleArtifactNamespace;
  try {
    namespace = await importModule(entryUrl);
  } catch (error) {
    throw new ModuleArtifactLoadError("import", "Module artifact import failed", error);
  }

  if (typeof namespace.runtimeMarker !== "string" || typeof namespace.activate !== "function") {
    throw new ModuleArtifactLoadError(
      "validate",
      "Module artifact must export a string runtimeMarker and activate(host)",
    );
  }

  let runtime: ModuleArtifactRuntime;
  try {
    runtime = namespace.activate({ react: React });
  } catch (error) {
    throw new ModuleArtifactLoadError("activate", "Module artifact activation failed", error);
  }

  if (runtime.marker !== namespace.runtimeMarker || runtime.react !== React) {
    throw new ModuleArtifactLoadError(
      "validate",
      "Module artifact did not retain the host React singleton and runtime marker",
    );
  }

  return { digest, entryUrl, marker: namespace.runtimeMarker, runtime };
}
