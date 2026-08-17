import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
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

async function rustSourceTree(relativePath) {
  const directory = path.join(repositoryRoot, relativePath);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".rs"))
    .map((entry) => path.join(directory, entry.name));
  return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
}

const allowedNativeAuthorityOwners = [
  "core/backend/src/semantic_terminal",
  "core/tauri/src/semantic_terminal.rs",
];
const allowedFeaturePolicyOwners = ["modules/semantic-terminal/frontend"];

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
    mutate: (snapshot) => snapshot.nativeAuthorityOwners.push("modules/semantic-terminal/backend"),
  },
  {
    classification: "feature-policy",
    mutate: (snapshot) => snapshot.featurePolicyOwners.push("core/tauri/src/semantic_terminal.rs"),
  },
  {
    classification: "rust",
    mutate: (snapshot) => snapshot.rust.push("modules/semantic-terminal/core/src/lib.rs"),
  },
  {
    classification: "cargo",
    mutate: (snapshot) => snapshot.cargo.push("semantic-terminal-module"),
  },
  {
    classification: "tauri",
    mutate: (snapshot) => snapshot.tauri.push("shipctl_module_semantic_terminal_host::install"),
  },
  {
    classification: "acl",
    mutate: (snapshot) => snapshot.acl.push("shipctl-semantic-terminal:allow-input-semantic-terminal"),
  },
  {
    classification: "private-command",
    mutate: (snapshot) => snapshot["private-command"].push("plugin:shipctl-semantic-terminal|input_semantic_terminal"),
  },
);

test("architecture.semantic-terminal-native-extraction-closure.property", async () => {
  const architecture = await inspectArchitecture(repositoryRoot);
  const semanticTerminal = architecture.modules.find(({ id }) => id === "semantic-terminal");
  assert.ok(semanticTerminal, "Semantic Terminal must remain a declared frontend module");
  assert.equal(semanticTerminal.manifest.backend, null);
  assert.equal(semanticTerminal.manifest.tauri, null);
  assert.equal(semanticTerminal.manifest.profile, null);
  assert.deepEqual(semanticTerminal.native_crates, []);
  assert.deepEqual(semanticTerminal.frontend_source.direct_tauri_imports, []);
  for (const directory of [
    "modules/semantic-terminal/backend",
    "modules/semantic-terminal/core",
    "modules/semantic-terminal/host",
  ]) {
    assert.equal(await exists(directory), false);
  }

  const [
    cargo,
    lock,
    tauriConfiguration,
    tauriShell,
    moduleComposition,
    usageProfile,
    client,
    adapter,
    cli,
    provider,
  ] = await Promise.all([
    source("src-tauri/Cargo.toml"),
    source("Cargo.lock"),
    source("src-tauri/tauri.conf.json"),
    source("src-tauri/src/lib.rs"),
    source("src-tauri/src/modules/mod.rs"),
    source("ops/modularity/profiles/usage-disabled/tauri.conf.json"),
    source("core/frontend/platform/semanticTerminals.ts"),
    source("core/tauri/src/semantic_terminal.rs"),
    source("cli/src/terminals.rs"),
    rustSourceTree("core/backend/src/semantic_terminal"),
  ]);
  const cargoGraph = `${cargo}\n${lock}`;
  const aclGraph = `${tauriConfiguration}\n${usageProfile}`;
  const shellGraph = `${tauriShell}\n${moduleComposition}`;
  assert.doesNotMatch(
    cargoGraph,
    /semantic-terminal-module|shipctl-module-semantic-terminal|tauri-plugin-shipctl-semantic-terminal/,
  );
  assert.doesNotMatch(aclGraph, /shipctl-semantic-terminal/);
  assert.doesNotMatch(shellGraph, /shipctl_module_semantic_terminal|plugin:shipctl-semantic-terminal/);
  assert.doesNotMatch(client, /plugin:shipctl-semantic-terminal\|/);
  assert.doesNotMatch(cli, /shipctl_module_semantic_terminal_core/);
  assert.doesNotMatch(provider, /(?:use|extern crate)\s+tauri\b/);
  assert.doesNotMatch(adapter, /cfg!\s*\(|#\s*\[cfg|semantic-terminal-module/);
  assert.match(adapter, /PrivateSemanticTerminalRequest/);
  assert.match(adapter, /release_semantic_terminal_activation/);
  assert.match(client, /releaseActivation/);
  for (const nativeCommand of [
    "get_semantic_terminal_snapshot",
    "attach_semantic_terminal",
    "credit_semantic_terminal_screen",
    "detach_semantic_terminal",
    "resize_semantic_terminal",
    "input_semantic_terminal",
    "history_semantic_terminal",
    "anchor_semantic_terminal",
    "resolve_semantic_terminal_anchor",
    "release_semantic_terminal_anchor",
    "select_semantic_terminal",
    "is_semantic_terminal_paste_safe",
    "get_semantic_terminal_publication_stats",
    "get_semantic_terminal_app_memory",
    "release_semantic_terminal_activation",
  ]) {
    assert.match(client, new RegExp(`\\b${nativeCommand}\\b`));
    assert.match(adapter, new RegExp(`\\b${nativeCommand}\\b`));
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
