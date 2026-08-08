import { invoke } from "@tauri-apps/api/core";
import * as React from "react";

import {
  MODULE_ARTIFACT_LOADER_SCHEMA_VERSION,
  ModuleArtifactLoadError,
  loadModuleArtifact,
  moduleArtifactUrl,
} from "./moduleArtifactLoader.ts";

interface ProbeArtifact {
  readonly label: "A" | "B" | "C";
  readonly digestSha256: string;
  readonly entryPath: string;
}

interface ProbePlan {
  readonly schemaVersion: number;
  readonly artifacts: readonly ProbeArtifact[];
}

interface ProbeObservation {
  readonly label: string;
  readonly marker: string;
  readonly digestSha256: string;
  readonly entryUrl: string;
  readonly reactSingleton: boolean;
}

interface ProbeFailure {
  readonly code: string;
  readonly phase: string;
  readonly summary: string;
}

interface ProbeResult {
  readonly schemaVersion: number;
  readonly success: boolean;
  readonly observed: Record<string, unknown>;
  readonly diagnostics: readonly object[];
}

function summary(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(error: unknown): ProbeFailure {
  if (error instanceof ModuleArtifactLoadError) {
    return { code: error.code, phase: error.phase, summary: error.message };
  }
  return { code: "module.loader.probe_failed", phase: "probe", summary: summary(error) };
}

async function complete(result: ProbeResult): Promise<void> {
  await invoke("complete_module_loader_probe", { result });
}

/**
 * Runs only when the shell has consumed an explicit, instance-rooted probe
 * request. Ordinary app startup receives `null` and continues unchanged.
 */
export async function runModuleLoaderProbeIfRequested(): Promise<boolean> {
  const plan = await invoke<ProbePlan | null>("take_module_loader_probe");
  if (plan === null) return false;

  const webviewBefore = `${window.location.href}:${performance.timeOrigin}`;
  const observations: ProbeObservation[] = [];
  const diagnostics: object[] = [];
  let result: ProbeResult;

  try {
    if (plan.schemaVersion !== MODULE_ARTIFACT_LOADER_SCHEMA_VERSION) {
      throw new Error(`Unsupported module loader probe schema ${plan.schemaVersion}`);
    }
    const [a, b, c] = plan.artifacts;
    if (a?.label !== "A" || b?.label !== "B" || c?.label !== "C") {
      throw new Error("Module loader probe must provide A, B, C artifacts in order");
    }

    const load = async (artifact: ProbeArtifact) => {
      const entryUrl = moduleArtifactUrl(artifact.entryPath, artifact.digestSha256);
      const loaded = await loadModuleArtifact({ digest: artifact.digestSha256, entryUrl });
      const observation = {
        label: artifact.label,
        marker: loaded.marker,
        digestSha256: loaded.digest,
        entryUrl: loaded.entryUrl,
        reactSingleton: loaded.runtime.react === React,
      };
      observations.push(observation);
      return loaded;
    };

    const loadedA = await load(a);
    const loadedB = await load(b);
    let failedC: ProbeFailure | undefined;
    try {
      await load(c);
      throw new Error("Fixture C unexpectedly loaded");
    } catch (error) {
      failedC = failure(error);
    }
    const reusedB = await load(b);
    const webviewAfter = `${window.location.href}:${performance.timeOrigin}`;
    const success = loadedA.marker === "A"
      && loadedB.marker === "B"
      && reusedB.marker === "B"
      && observations.every((observation) => observation.reactSingleton)
      && failedC.code === "module.loader.import_failed"
      && failedC.phase === "import"
      && webviewBefore === webviewAfter;
    result = {
      schemaVersion: MODULE_ARTIFACT_LOADER_SCHEMA_VERSION,
      success,
      observed: {
        artifacts: observations,
        markerAfterSwap: loadedB.marker,
        failedC,
        usableAfterC: { marker: reusedB.marker, reactSingleton: reusedB.runtime.react === loadedB.runtime.react },
        hostReactSingleton: loadedA.runtime.react === loadedB.runtime.react,
        noWebviewReload: webviewBefore === webviewAfter,
      },
      diagnostics,
    };
  } catch (error) {
    const diagnostic = failure(error);
    diagnostics.push(diagnostic);
    result = {
      schemaVersion: MODULE_ARTIFACT_LOADER_SCHEMA_VERSION,
      success: false,
      observed: { artifacts: observations, noWebviewReload: false },
      diagnostics,
    };
  }

  await complete(result);
  return true;
}
