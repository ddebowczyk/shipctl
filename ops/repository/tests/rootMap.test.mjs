import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateRootMap } from "../bin/root-map.mjs";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function map(entries) {
  return {
    schema_version: 1,
    groups: [
      { id: "operations", description: "Repository operations." },
      { id: "unknown", description: "Awaiting classification." },
    ],
    entries,
  };
}

async function fixture(t, entries) {
  const root = await mkdtemp(path.join(tmpdir(), "shipctl-root-map-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "ops/repository"), { recursive: true });
  await writeFile(path.join(root, "ops/repository/root-map.yaml"), JSON.stringify(map(entries)));
  return root;
}

test("the live repository root is completely and validly mapped", () => {
  assert.deepEqual(validateRootMap(repositoryRoot), []);
});

test("a new root entry must be assigned to a map group", async (t) => {
  const root = await fixture(t, [
    { path: "ops", kind: "directory", group: "operations", description: "Operations." },
  ]);
  await writeFile(path.join(root, "surprise.txt"), "unexpected");

  assert.ok(validateRootMap(root).some(({ rule }) => rule === "unmapped-root-entry"));
});

test("unknown is visible work rather than an accepted classification", async (t) => {
  const root = await fixture(t, [
    { path: "ops", kind: "directory", group: "operations", description: "Operations." },
    { path: "surprise.txt", kind: "file", group: "unknown", description: "Needs review." },
  ]);
  await writeFile(path.join(root, "surprise.txt"), "unexpected");

  assert.ok(validateRootMap(root).some(({ rule }) => rule === "root-entry-needs-classification"));
});
