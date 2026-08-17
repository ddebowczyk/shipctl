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
  "core/backend/src/skill_installation",
  "core/tauri/src/skill_installation.rs",
];
const allowedFeaturePolicyOwners = ["modules/skills/frontend"];

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
    mutate: (snapshot) => snapshot.nativeAuthorityOwners.push("modules/skills/backend"),
  },
  {
    classification: "feature-policy",
    mutate: (snapshot) => snapshot.featurePolicyOwners.push("core/tauri/src/skill_installation.rs"),
  },
  {
    classification: "rust",
    mutate: (snapshot) => snapshot.rust.push("modules/skills/backend/src/lib.rs"),
  },
  {
    classification: "cargo",
    mutate: (snapshot) => snapshot.cargo.push("skills-module"),
  },
  {
    classification: "tauri",
    mutate: (snapshot) => snapshot.tauri.push("shipctl_module_skills_host::install"),
  },
  {
    classification: "acl",
    mutate: (snapshot) => snapshot.acl.push("shipctl-skills:allow-list-skills"),
  },
  {
    classification: "private-command",
    mutate: (snapshot) => snapshot["private-command"].push("plugin:shipctl-skills|list_skills"),
  },
);

test("architecture.skills-native-extraction-closure.property", async () => {
  const architecture = await inspectArchitecture(repositoryRoot);
  const skills = architecture.modules.find(({ id }) => id === "skills");
  assert.ok(skills, "Skills must remain a declared frontend module");
  assert.equal(skills.manifest.backend, null);
  assert.equal(skills.manifest.tauri, null);
  assert.equal(skills.manifest.profile, null);
  assert.deepEqual(skills.native_crates, []);
  assert.equal(await exists("modules/skills/backend"), false);
  assert.equal(await exists("modules/skills/host"), false);

  const [cargo, lock, tauriConfiguration, tauriShell, moduleComposition, fixture] = await Promise.all([
    source("src-tauri/Cargo.toml"),
    source("Cargo.lock"),
    source("src-tauri/tauri.conf.json"),
    source("src-tauri/src/lib.rs"),
    source("src-tauri/src/modules/mod.rs"),
    source("ops/modularity/fixtures/panel-host/main.tsx"),
  ]);
  const cargoGraph = `${cargo}\n${lock}`;
  assert.doesNotMatch(cargoGraph, /skills-module|shipctl-module-skills|tauri-plugin-shipctl-skills/);
  assert.doesNotMatch(tauriConfiguration, /shipctl-skills/);
  assert.doesNotMatch(`${tauriShell}\n${moduleComposition}`, /shipctl_module_skills|plugin:shipctl-skills/);
  assert.doesNotMatch(fixture, /plugin:shipctl-skills/);

  const [provider, adapter, client, catalog, todos, orchestrate] = await Promise.all([
    source("core/backend/src/skill_installation/mod.rs"),
    source("core/tauri/src/skill_installation.rs"),
    source("core/frontend/platform/skillInstallation.ts"),
    source("modules/skills/frontend/src/catalog.ts"),
    source("modules/skills/frontend/resources/todo_skill.md"),
    source("modules/skills/frontend/resources/orchestrate_skill.md"),
  ]);
  assert.doesNotMatch(provider, /(?:use|extern crate)\s+tauri\b/);
  assert.doesNotMatch(provider, /Project to-dos|Turns any agent into a planner/);
  assert.doesNotMatch(adapter, /shipctl-todos|orchestrate|Project to-dos|BUILTIN_SKILL/);
  assert.doesNotMatch(client, /plugin:shipctl-skills\|/);
  assert.match(catalog, /BUILTIN_SKILL_SOURCES/);
  assert.match(todos, /name:\s+shipctl-todos/);
  assert.match(orchestrate, /name:\s+orchestrate/);
  for (const nativeCommand of [
    "inspect_skill_installations",
    "install_skill_source",
    "remove_skill_installation",
    "release_skill_installation_activation",
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
