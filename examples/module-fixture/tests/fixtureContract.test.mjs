import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const fixtureRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = join(fixtureRoot, "..", "..");
const manifest = join(fixtureRoot, "module.yaml");
const schema = join(repositoryRoot, "ops", "modularity", "schema", "module.schema.yaml");

test("the example is a valid static module with a bounded message contract", async () => {
  const result = spawnSync("ys", ["--json", "-f", schema, manifest], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const payloadSchema = JSON.parse(
    await readFile(join(fixtureRoot, "messages", "agent-wakeup.schema.json"), "utf8"),
  );
  assert.equal(payloadSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(payloadSchema.additionalProperties, false);
});
