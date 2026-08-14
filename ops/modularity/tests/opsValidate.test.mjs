import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateInvariants } from "../../bin/ops-validate.mjs";

async function put(root, relative, contents) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

function capability(id, extra = {}) {
  return {
    schema_version: 1,
    id,
    provides: id,
    description: `${id} fixture`,
    status: "supported",
    requires: { tools: [], capabilities: [] },
    owns: [`ops/${id}/**`],
    reads: [],
    generates: [],
    commands: [{ name: "ping", summary: "Fixture command", lane: "fast" }],
    skills: [],
    ...extra,
  };
}

async function fixture({ mutate, files = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "shipctl-ops-validate-"));
  const manifests = {
    check: capability("check"),
    modularity: capability("modularity", {
      owns: ["ops/modularity/**", "ops/ops.yaml", "ops/justfile"],
    }),
  };
  const ops = { schema_version: 1, active: { check: "check", modularity: "modularity" } };
  mutate?.({ manifests, ops });

  await put(root, "package.json", JSON.stringify({ scripts: {} }));
  await put(root, "Cargo.toml", '[workspace]\nmembers = ["module-api/backend", "modules/*/backend"]\n');
  await put(root, "core/frontend/package.json", JSON.stringify({ name: "@shipctl/core", exports: {} }));
  await put(root, "core/frontend/host/index.ts", "export const host = true;");
  await put(root, "module-api/frontend/package.json", JSON.stringify({ name: "@shipctl/module-api" }));
  await put(root, "module-api/frontend/src/index.ts", "export const api = true;");
  await put(root, "src/main.tsx", "export {};");
  await put(root, "src/vite-env.d.ts", "/// <reference types='vite/client' />");
  await put(root, "ops/ops.yaml", JSON.stringify(ops));
  await put(root, "ops/justfile", "validate:\n    echo valid\n");
  for (const [id, manifest] of Object.entries(manifests)) {
    await put(root, `ops/${id}/capability.yaml`, JSON.stringify(manifest));
    await put(root, `ops/${id}/justfile`, "ping:\n    echo pong\n");
    await put(root, `ops/${id}/skills/README.md`, "# Skills\n");
  }
  for (const [relative, contents] of Object.entries(files)) await put(root, relative, contents);
  return root;
}

async function rules(root) {
  return (await validateInvariants(root)).map(({ rule }) => rule);
}

test("rejects application imports from ops", async (t) => {
  const root = await fixture({ files: { "src/main.tsx": "import '../ops/check/justfile';" } });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.ok((await rules(root)).includes("app-ops-import"));
});

test("rejects ops in Vite inputs, Cargo members, and built bundles", async (t) => {
  const root = await fixture({
    files: {
      "Cargo.toml": '[workspace]\nmembers = ["ops/check"]\n',
      "vite.config.ts": "export default { build: { rollupOptions: { input: 'ops/check/index.html' } } };",
      "dist/app.js": "const source = 'ops/check';",
    },
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const actual = await rules(root);
  assert.ok(actual.includes("ops-vite-input"));
  assert.ok(actual.includes("ops-cargo-member"));
  assert.ok(actual.includes("ops-built-bundle"));
});

test("rejects overlapping owners and paths without exactly one owner", async (t) => {
  const root = await fixture({
    mutate: ({ manifests }) => {
      manifests.check.owns.push("ops/shared/**");
      manifests.modularity.owns.push("ops/shared/**");
    },
    files: { "ops/shared/probe.txt": "shared" },
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const actual = await rules(root);
  assert.ok(actual.includes("overlapping-owns"));
  assert.ok(actual.includes("ops-path-owner"));
});

test("rejects literal writes outside owns and generates", async (t) => {
  const root = await fixture({
    files: { ["ops/check/" + "bin/probe.mjs"]: "write" + "File('../../../outside.txt', 'bad');" },
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.ok((await rules(root)).includes("write-outside-boundary"));
});

test("rejects unowned root executables and a returned scripts directory", async (t) => {
  const root = await fixture({
    files: {
      "package.json": JSON.stringify({ scripts: { legacy: "node scripts/legacy.mjs" } }),
      "tools/run.mjs": "export {};",
      "scripts/legacy.mjs": "export {};",
    },
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const actual = await rules(root);
  assert.ok(actual.includes("unowned-root-executables"));
  assert.ok(actual.includes("legacy-scripts-returned"));
});

test("accepts a root example explicitly owned by one operation capability", async (t) => {
  const root = await fixture({
    mutate: ({ manifests }) => manifests.modularity.owns.push("examples/demo/**"),
    files: { "examples/demo/run.mjs": "export {};" },
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.ok(!(await rules(root)).includes("unowned-root-executables"));
});

test("rejects dependency, recipe, skill, provider, and peer-bin drift", async (t) => {
  const root = await fixture({
    mutate: ({ manifests, ops }) => {
      manifests.check.requires.capabilities = ["modularity"];
      manifests.modularity.requires.capabilities = ["check"];
      manifests.check.commands.push({ name: "absent", summary: "Missing", lane: "fast" });
      manifests.check.skills.push({ name: "missing", summary: "Missing procedure" });
      ops.active.check = "modularity";
    },
    files: { ["ops/check/" + "bin/probe.mjs"]: "import '../../modularity/" + "bin/runner.mjs';" },
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const actual = await rules(root);
  for (const expected of ["capability-cycle", "missing-recipe", "missing-skill", "provider-interface", "peer-bin-import"]) {
    assert.ok(actual.includes(expected), `${expected} was not reported`);
  }
});

test("does not require an empty skills directory", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await rm(path.join(root, "ops/check/skills"), { recursive: true, force: true });

  assert.ok(!(await rules(root)).includes("missing-skill"));
});
