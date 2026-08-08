import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateYaml } from "../bin/check-schemas.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("a malformed capability manifest fails schema validation", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "shipctl-malformed-manifest-"));
  try {
    const manifest = path.join(temporary, "capability.yaml");
    await writeFile(manifest, `---
schema_version: 1
id: INVALID
unexpected: true
`);
    await assert.rejects(
      validateYaml(manifest, path.join(root, "ops/schema/capability.schema.yaml")),
      /Additional property 'unexpected' is not allowed/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
