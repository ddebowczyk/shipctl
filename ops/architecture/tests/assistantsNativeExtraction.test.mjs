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
  "core/backend/src/assistant_launch",
  "core/backend/src/credentials",
  "core/tauri/src/assistant_launch.rs",
  "core/tauri/src/credentials.rs",
];
const allowedFeaturePolicyOwners = ["modules/assistants/frontend"];

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
    mutate: (snapshot) => snapshot.nativeAuthorityOwners.push("modules/assistants/backend"),
  },
  {
    classification: "feature-policy",
    mutate: (snapshot) => snapshot.featurePolicyOwners.push("core/tauri/src/assistant_launch.rs"),
  },
  {
    classification: "rust",
    mutate: (snapshot) => snapshot.rust.push("modules/assistants/backend/src/lib.rs"),
  },
  {
    classification: "cargo",
    mutate: (snapshot) => snapshot.cargo.push("assistants-module"),
  },
  {
    classification: "tauri",
    mutate: (snapshot) => snapshot.tauri.push("shipctl_module_assistants_host::install"),
  },
  {
    classification: "acl",
    mutate: (snapshot) => snapshot.acl.push("shipctl-assistants:allow-spawn-assistant-session"),
  },
  {
    classification: "private-command",
    mutate: (snapshot) => snapshot["private-command"].push("plugin:shipctl-assistants|spawn_assistant_session"),
  },
);

test("architecture.assistants-native-extraction-closure.property", async () => {
  const architecture = await inspectArchitecture(repositoryRoot);
  const assistants = architecture.modules.find(({ id }) => id === "assistants");
  assert.ok(assistants, "Assistants must remain a declared frontend module");
  assert.equal(assistants.manifest.backend, null);
  assert.equal(assistants.manifest.tauri, null);
  assert.equal(assistants.manifest.profile, null);
  assert.deepEqual(assistants.native_crates, []);
  assert.equal(await exists("modules/assistants/backend"), false);
  assert.equal(await exists("modules/assistants/host"), false);

  const [workspaceCargo, cargo, lock, tauriConfiguration, tauriShell, moduleComposition] = await Promise.all([
    source("Cargo.toml"),
    source("src-tauri/Cargo.toml"),
    source("Cargo.lock"),
    source("src-tauri/tauri.conf.json"),
    source("src-tauri/src/lib.rs"),
    source("src-tauri/src/modules/mod.rs"),
  ]);
  const cargoGraph = `${workspaceCargo}\n${cargo}\n${lock}`;
  assert.doesNotMatch(cargoGraph, /assistants-module|shipctl-module-assistants|tauri-plugin-shipctl-assistants/);
  assert.doesNotMatch(tauriConfiguration, /shipctl-assistants/);
  assert.doesNotMatch(`${tauriShell}\n${moduleComposition}`, /shipctl_module_assistants|plugin:shipctl-assistants/);

  const [provider, credentialProvider, adapter, credentialAdapter, client, credentialClient] = await Promise.all([
    source("core/backend/src/assistant_launch/mod.rs"),
    source("core/backend/src/credentials/mod.rs"),
    source("core/tauri/src/assistant_launch.rs"),
    source("core/tauri/src/credentials.rs"),
    source("core/frontend/platform/assistantLaunch.ts"),
    source("core/frontend/platform/credentials.ts"),
  ]);
  assert.doesNotMatch(`${provider}\n${credentialProvider}`, /(?:use|extern crate)\s+tauri\b/);
  assert.doesNotMatch(`${adapter}\n${credentialAdapter}`, /SessionLauncher|assistantLogo|CODING_ASSISTANTS|selectedAssistant/);
  assert.doesNotMatch(`${client}\n${credentialClient}`, /plugin:shipctl-assistants\|/);
  for (const nativeCommand of [
    "start_assistant_session",
    "resume_assistant_session",
    "release_assistant_launch_activation",
    "inspect_credential",
    "save_credential",
    "delete_credential",
    "release_credential_store_activation",
  ]) {
    assert.match(`${client}\n${credentialClient}`, new RegExp(`\\b${nativeCommand}\\b`));
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
