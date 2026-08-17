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
  "core/backend/src/project_documents",
  "core/tauri/src/project_documents.rs",
];
const allowedFeaturePolicyOwners = ["modules/todos/frontend"];

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
    mutate: (snapshot) => snapshot.nativeAuthorityOwners.push("modules/todos/backend"),
  },
  {
    classification: "feature-policy",
    mutate: (snapshot) => snapshot.featurePolicyOwners.push("core/tauri/src/project_documents.rs"),
  },
  {
    classification: "rust",
    mutate: (snapshot) => snapshot.rust.push("modules/todos/backend/src/lib.rs"),
  },
  {
    classification: "cargo",
    mutate: (snapshot) => snapshot.cargo.push("todos-module"),
  },
  {
    classification: "tauri",
    mutate: (snapshot) => snapshot.tauri.push("shipctl_module_todos_host::install"),
  },
  {
    classification: "acl",
    mutate: (snapshot) => snapshot.acl.push("shipctl-todos:allow-read-todos"),
  },
  {
    classification: "private-command",
    mutate: (snapshot) => snapshot["private-command"].push("plugin:shipctl-todos|read_todos"),
  },
);

test("architecture.todos-native-extraction-closure.property", async () => {
  const architecture = await inspectArchitecture(repositoryRoot);
  const todos = architecture.modules.find(({ id }) => id === "todos");
  assert.ok(todos, "Todos must remain a declared frontend module");
  assert.equal(todos.manifest.backend, null);
  assert.equal(todos.manifest.tauri, null);
  assert.equal(todos.manifest.profile, null);
  assert.deepEqual(todos.native_crates, []);
  assert.equal(await exists("modules/todos/backend"), false);
  assert.equal(await exists("modules/todos/host"), false);

  const [cargo, lock, tauriConfiguration, tauriShell, moduleComposition, fixture] = await Promise.all([
    source("src-tauri/Cargo.toml"),
    source("Cargo.lock"),
    source("src-tauri/tauri.conf.json"),
    source("src-tauri/src/lib.rs"),
    source("src-tauri/src/modules/mod.rs"),
    source("ops/modularity/fixtures/panel-host/main.tsx"),
  ]);
  const cargoGraph = `${cargo}\n${lock}`;
  assert.doesNotMatch(cargoGraph, /todos-module|shipctl-module-todos|tauri-plugin-shipctl-todos/);
  assert.doesNotMatch(tauriConfiguration, /shipctl-todos/);
  assert.doesNotMatch(`${tauriShell}\n${moduleComposition}`, /shipctl_module_todos|shipctl-todos/);
  assert.doesNotMatch(fixture, /plugin:shipctl-todos/);

  const [provider, adapter, client, todoPolicy] = await Promise.all([
    source("core/backend/src/project_documents/mod.rs"),
    source("core/tauri/src/project_documents.rs"),
    source("core/frontend/platform/projectDocuments.ts"),
    source("modules/todos/frontend/src/todoDocuments.ts"),
  ]);
  assert.doesNotMatch(provider, /\btauri\b/i);
  assert.doesNotMatch(
    adapter,
    /parseTodoDocument|toggleTodoContents|moveTodoContents|createTodoContents|addTodoContents/,
  );
  assert.doesNotMatch(client, /plugin:shipctl-todos|read_todos|toggle_todo|add_todo|move_todo/);
  for (const policySymbol of [
    "parseTodoDocument",
    "toggleTodoContents",
    "moveTodoContents",
    "createTodoContents",
    "addTodoContents",
  ]) {
    assert.match(todoPolicy, new RegExp(`\\b${policySymbol}\\b`));
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
