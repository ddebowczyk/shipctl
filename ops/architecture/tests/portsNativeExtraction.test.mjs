import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import fc from "fast-check";

import { inspectArchitecture } from "../bin/inspect.mjs";

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

async function source(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

const allowedNativeAuthorityOwners = [
  "core/backend/src/processes",
  "core/tauri/src/processes.rs",
];
const allowedFeaturePolicyOwners = ["modules/ports/frontend"];

function closureDiagnostics(snapshot) {
  const diagnostics = [];
  if (JSON.stringify(snapshot.nativeAuthorityOwners) !== JSON.stringify(allowedNativeAuthorityOwners)) {
    diagnostics.push("native-authority");
  }
  if (JSON.stringify(snapshot.featurePolicyOwners) !== JSON.stringify(allowedFeaturePolicyOwners)) {
    diagnostics.push("feature-policy");
  }
  for (const field of ["rust", "cargo", "tauri", "acl", "private-command"]) {
    if (snapshot[field].length > 0) diagnostics.push(field);
  }
  return diagnostics.sort();
}

const forbiddenEdgeArbitrary = fc.constantFrom(
  {
    classification: "native-authority",
    mutate: (snapshot) => snapshot.nativeAuthorityOwners.push("modules/ports/backend"),
  },
  {
    classification: "feature-policy",
    mutate: (snapshot) => snapshot.featurePolicyOwners.push("core/tauri/src/processes.rs"),
  },
  {
    classification: "rust",
    mutate: (snapshot) => snapshot.rust.push("modules/ports/backend/src/lib.rs"),
  },
  {
    classification: "cargo",
    mutate: (snapshot) => snapshot.cargo.push("ports-module"),
  },
  {
    classification: "tauri",
    mutate: (snapshot) => snapshot.tauri.push("shipctl_module_ports_host::install"),
  },
  {
    classification: "acl",
    mutate: (snapshot) => snapshot.acl.push("shipctl-ports:allow-kill-port"),
  },
  {
    classification: "private-command",
    mutate: (snapshot) => snapshot["private-command"].push("plugin:shipctl-ports|kill_port"),
  },
);

test("architecture.native-extraction-closure.property", async () => {
  const architecture = await inspectArchitecture(repositoryRoot);
  const ports = architecture.modules.find(({ id }) => id === "ports");
  assert.ok(ports, "Ports must remain a declared frontend module");
  assert.equal(ports.manifest.backend, null);
  assert.equal(ports.manifest.tauri, null);
  assert.equal(ports.manifest.profile, null);
  assert.deepEqual(ports.native_crates, []);
  assert.equal(await exists("modules/ports/backend"), false);
  assert.equal(await exists("modules/ports/host"), false);

  const [cargo, lock, tauriConfiguration, tauriShell, moduleComposition] = await Promise.all([
    source("src-tauri/Cargo.toml"),
    source("Cargo.lock"),
    source("src-tauri/tauri.conf.json"),
    source("src-tauri/src/lib.rs"),
    source("src-tauri/src/modules/mod.rs"),
  ]);
  const cargoGraph = `${cargo}\n${lock}`;
  assert.doesNotMatch(cargoGraph, /ports-module|shipctl-module-ports|tauri-plugin-shipctl-ports/);
  assert.doesNotMatch(tauriConfiguration, /shipctl-ports/);
  assert.doesNotMatch(`${tauriShell}\n${moduleComposition}`, /shipctl_module_ports|shipctl-ports/);

  const [provider, adapter, client, portsPolicy] = await Promise.all([
    source("core/backend/src/processes/mod.rs"),
    source("core/tauri/src/processes.rs"),
    source("core/frontend/platform/processes.ts"),
    source("modules/ports/frontend/src/PortsPanel.tsx"),
  ]);
  assert.doesNotMatch(provider, /\btauri\b/i);
  assert.doesNotMatch(adapter, /detectFramework|isDevelopmentProcess|matchProject|PortInfo|spotify/i);
  assert.doesNotMatch(client, /plugin:shipctl-ports|list_listening_ports|kill_port/);
  for (const policySymbol of [
    "PROJECT_ROOT_MARKERS",
    "FRAMEWORK_FILE_NAMES",
    "isDevelopmentProcess",
    "matchProject",
    "detectFramework",
  ]) {
    assert.match(portsPolicy, new RegExp(`\\b${policySymbol}\\b`));
  }

  const closedSnapshot = {
    nativeAuthorityOwners: [...allowedNativeAuthorityOwners],
    featurePolicyOwners: [...allowedFeaturePolicyOwners],
    rust: [],
    cargo: [],
    tauri: [],
    acl: [],
    "private-command": [],
  };
  assert.deepEqual(closureDiagnostics(closedSnapshot), []);

  await fc.assert(fc.asyncProperty(forbiddenEdgeArbitrary, async (edge) => {
    const mutated = structuredClone(closedSnapshot);
    edge.mutate(mutated);
    assert.deepEqual(closureDiagnostics(mutated), [edge.classification]);
  }), propertyParameters());
});
