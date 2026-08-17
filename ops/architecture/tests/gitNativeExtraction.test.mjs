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
  "core/backend/src/git",
  "core/tauri/src/git.rs",
  "core/tauri/src/projects_watcher.rs",
];
const allowedFeaturePolicyOwners = ["modules/git/frontend"];

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
    mutate: (snapshot) => snapshot.nativeAuthorityOwners.push("modules/git/backend"),
  },
  {
    classification: "feature-policy",
    mutate: (snapshot) => snapshot.featurePolicyOwners.push("core/tauri/src/git.rs"),
  },
  {
    classification: "rust",
    mutate: (snapshot) => snapshot.rust.push("modules/git/backend/src/lib.rs"),
  },
  {
    classification: "cargo",
    mutate: (snapshot) => snapshot.cargo.push("git-module"),
  },
  {
    classification: "tauri",
    mutate: (snapshot) => snapshot.tauri.push("shipctl_module_git_host::install"),
  },
  {
    classification: "acl",
    mutate: (snapshot) => snapshot.acl.push("shipctl-git:allow-git-status"),
  },
  {
    classification: "private-command",
    mutate: (snapshot) => snapshot["private-command"].push("plugin:shipctl-git|git_status"),
  },
);

test("architecture.git-native-extraction-closure.property", async () => {
  const architecture = await inspectArchitecture(repositoryRoot);
  const git = architecture.modules.find(({ id }) => id === "git");
  assert.ok(git, "Git must remain a declared frontend module");
  assert.equal(git.manifest.backend, null);
  assert.equal(git.manifest.tauri, null);
  assert.equal(git.manifest.profile, null);
  assert.deepEqual(git.native_crates, []);
  assert.equal(await exists("modules/git/backend"), false);
  assert.equal(await exists("modules/git/host"), false);

  const [cargo, lock, tauriConfiguration, tauriShell, moduleComposition, fixture] = await Promise.all([
    source("src-tauri/Cargo.toml"),
    source("Cargo.lock"),
    source("src-tauri/tauri.conf.json"),
    source("src-tauri/src/lib.rs"),
    source("src-tauri/src/modules/mod.rs"),
    source("ops/modularity/fixtures/panel-host/main.tsx"),
  ]);
  const cargoGraph = `${cargo}\n${lock}`;
  assert.doesNotMatch(cargoGraph, /git-module|shipctl-module-git|tauri-plugin-shipctl-git/);
  assert.doesNotMatch(tauriConfiguration, /shipctl-git/);
  assert.doesNotMatch(`${tauriShell}\n${moduleComposition}`, /shipctl_module_git|plugin:shipctl-git/);
  assert.doesNotMatch(fixture, /plugin:shipctl-git/);

  const [provider, adapter, client] = await Promise.all([
    source("core/backend/src/git/mod.rs"),
    source("core/tauri/src/git.rs"),
    source("core/frontend/platform/git.ts"),
  ]);
  assert.doesNotMatch(provider, /(?:use|extern crate)\s+tauri\b/);
  assert.doesNotMatch(adapter, /GitPanel|DiffViewer|GitStatusRow|pushNotice|refreshPolicy/);
  assert.doesNotMatch(client, /plugin:shipctl-git\|/);
  for (const nativeCommand of [
    "git_is_repository",
    "git_inspect_status",
    "git_list_changed_files",
    "release_git_activation",
  ]) {
    assert.match(client, new RegExp(`\\b${nativeCommand}\\b`));
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
