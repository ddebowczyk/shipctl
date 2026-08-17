import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import fc from "fast-check";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function propertyParameters() {
  const configured = process.env.SHIPCTL_PROPERTY_SEED;
  if (configured === undefined) return {};
  const seed = Number(configured);
  if (!Number.isSafeInteger(seed)) {
    throw new Error("SHIPCTL_PROPERTY_SEED must be a safe integer");
  }
  return { seed };
}

async function exists(relativePath) {
  try {
    await access(path.join(repositoryRoot, relativePath));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function filesBelow(relativePath) {
  if (!await exists(relativePath)) return [];
  const root = path.join(repositoryRoot, relativePath);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(repositoryRoot, path.join(entry.parentPath, entry.name)))
    .sort();
}

async function source(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

async function sourceTree(relativePath) {
  const files = await filesBelow(relativePath);
  return (await Promise.all(files.map(source))).join("\n");
}

function closureDiagnostics(snapshot) {
  const diagnostics = [];
  if (snapshot.moduleCargoManifests.length > 0) diagnostics.push("module-cargo-manifest");
  if (snapshot.moduleRustSources.length > 0) diagnostics.push("module-rust-source");
  if (snapshot.compatibilityCargoEdges.length > 0) diagnostics.push("compatibility-cargo-edge");
  if (snapshot.compatibilityImports.length > 0) diagnostics.push("compatibility-import");
  if (snapshot.missingCoreOwners.length > 0) diagnostics.push("core-owner");
  return diagnostics.sort();
}

const forbiddenEdgeArbitrary = fc.constantFrom(
  {
    classification: "module-cargo-manifest",
    mutate: (snapshot) => snapshot.moduleCargoManifests.push("modules/example/backend/Cargo.toml"),
  },
  {
    classification: "module-rust-source",
    mutate: (snapshot) => snapshot.moduleRustSources.push("module-api/backend/src/lib.rs"),
  },
  {
    classification: "compatibility-cargo-edge",
    mutate: (snapshot) => snapshot.compatibilityCargoEdges.push("shipctl-module-api"),
  },
  {
    classification: "compatibility-import",
    mutate: (snapshot) => snapshot.compatibilityImports.push("shipctl_module_api"),
  },
  {
    classification: "core-owner",
    mutate: (snapshot) => snapshot.missingCoreOwners.push("terminal driver registry"),
  },
);

test("architecture.module-api-backend-closure.property", async () => {
  const [moduleFiles, cargoLock, coreSource, tauriSource, appSource, stateModule, durableWrite,
    snapshotProvider, terminalDriver, driverRegistry] = await Promise.all([
    filesBelow("modules"),
    source("Cargo.lock"),
    sourceTree("core/backend/src"),
    sourceTree("core/tauri/src"),
    sourceTree("src-tauri/src"),
    source("core/backend/src/state/mod.rs"),
    source("core/backend/src/state/durable_write.rs"),
    source("core/backend/src/state/snapshot.rs"),
    source("core/backend/src/terminal_host/driver.rs"),
    source("core/backend/src/terminal_host/driver_registry.rs"),
  ]);
  const moduleApiFiles = await filesBelow("module-api");
  const moduleCargoManifests = [...moduleFiles, ...moduleApiFiles]
    .filter((file) => path.basename(file) === "Cargo.toml");
  const moduleRustSources = [...moduleFiles, ...moduleApiFiles]
    .filter((file) => path.extname(file) === ".rs");
  const compatibilityCargoEdges = [cargoLock]
    .filter((value) => /\bshipctl-module-api\b|module-api\/backend/.test(value));
  const compatibilityImports = [coreSource, tauriSource, appSource]
    .filter((value) => /\bshipctl_module_api\b/.test(value));
  const ownerChecks = [
    [stateModule, /pub use durable_write::DurableWriteBarrier;/, "durable write re-export"],
    [durableWrite, /pub struct DurableWriteBarrier\b/, "durable write barrier"],
    [snapshotProvider, /pub trait SnapshotProvider\b/, "snapshot provider"],
    [terminalDriver, /pub struct TerminalDriverId\b/, "terminal driver protocol"],
    [driverRegistry, /pub struct TerminalDriverRegistry\b/, "terminal driver registry"],
  ];
  const missingCoreOwners = ownerChecks
    .filter(([value, pattern]) => !pattern.test(value))
    .map(([, , label]) => label);
  const closedSnapshot = {
    moduleCargoManifests,
    moduleRustSources,
    compatibilityCargoEdges,
    compatibilityImports,
    missingCoreOwners,
  };

  assert.deepEqual(closureDiagnostics(closedSnapshot), []);

  await fc.assert(fc.asyncProperty(forbiddenEdgeArbitrary, async (edge) => {
    const mutated = structuredClone(closedSnapshot);
    edge.mutate(mutated);
    assert.deepEqual(closureDiagnostics(mutated), [edge.classification]);
  }), propertyParameters());
});
