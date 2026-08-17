import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const modularityRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const schema = join(modularityRoot, "schema", "module.schema.yaml");
const fixtures = join(modularityRoot, "tests", "fixtures", "module-manifests");

test("simple and host-adapter module manifests satisfy the schema", () => {
  for (const name of ["todos.yaml", "ports.yaml"]) {
    const result = spawnSync("ys", ["-f", schema, join(fixtures, name)], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
});

test("every product module manifest satisfies the schema", () => {
  const modules = join(repositoryRoot, "modules");
  for (const name of readdirSync(modules)) {
    const manifest = join(modules, name, "module.yaml");
    if (!existsSync(manifest)) continue;
    const result = spawnSync("ys", ["-f", schema, manifest], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
});

test("the module schema rejects undeclared escape hatches", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shipctl-module-schema-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const invalid = join(root, "invalid.yaml");
  const source = await readFile(join(fixtures, "todos.yaml"), "utf8");
  await writeFile(invalid, `${source}escape_hatch: true\n`);

  const result = spawnSync("ys", ["-f", schema, invalid], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
});
