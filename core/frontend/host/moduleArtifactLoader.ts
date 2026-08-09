import { convertFileSrc } from "@tauri-apps/api/core";
import * as React from "react";
import type { ShipctlModule } from "@shipctl/module-api";

export type ModuleArtifactLoadPhase = "resolve" | "import" | "validate" | "activate";

export interface ModuleArtifactHost {
  readonly react: typeof React;
}

interface ShipctlModuleArtifactNamespace {
  createShipctlModule?(host: ModuleArtifactHost): ShipctlModule;
}

export interface LoadShipctlModuleArtifactRequest {
  readonly digest: string;
  readonly entryUrl: string;
  readonly expectedModuleId: string;
  readonly expectedVersion: string;
  readonly importModule?: (url: string) => Promise<ShipctlModuleArtifactNamespace>;
}

export interface LoadedShipctlModuleArtifact {
  readonly digest: string;
  readonly entryUrl: string;
  readonly module: ShipctlModule;
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

const HEADLESS_MODULE_KEYS = new Set([
  "id",
  "version",
  "messages",
  "activate",
]);

/** Load the restart-bound runtime slice without mutating the static UI registries. */
export async function loadShipctlModuleArtifact({
  digest,
  entryUrl,
  expectedModuleId,
  expectedVersion,
  importModule = (url) => import(/* @vite-ignore */ url),
}: LoadShipctlModuleArtifactRequest): Promise<LoadedShipctlModuleArtifact> {
  assertDigestQualifiedArtifactUrl(entryUrl, digest);
  let namespace: ShipctlModuleArtifactNamespace;
  try {
    namespace = await importModule(entryUrl);
  } catch (error) {
    throw new ModuleArtifactLoadError("import", "Module artifact import failed", error);
  }
  if (typeof namespace.createShipctlModule !== "function") {
    throw new ModuleArtifactLoadError(
      "validate",
      "Module artifact must export createShipctlModule(host)",
    );
  }
  let module: ShipctlModule;
  try {
    module = namespace.createShipctlModule({ react: React });
  } catch (error) {
    throw new ModuleArtifactLoadError("activate", "Module artifact factory failed", error);
  }
  if (!module || module.id !== expectedModuleId || module.version !== expectedVersion) {
    throw new ModuleArtifactLoadError(
      "validate",
      "Module artifact identity does not match its admitted manifest",
    );
  }
  const unsupported = Object.keys(module).filter((key) => !HEADLESS_MODULE_KEYS.has(key));
  if (unsupported.length > 0) {
    throw new ModuleArtifactLoadError(
      "validate",
      `Restart-bound modules are headless; unsupported contributions: ${unsupported.join(", ")}`,
    );
  }
  return { digest, entryUrl, module };
}
