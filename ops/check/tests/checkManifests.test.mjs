import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateManifests } from "../bin/check-manifests.mjs";

test("a deliberate declaration mismatch fails manifest validation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "shep-manifests-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "modules/probe/frontend"), { recursive: true });
  await mkdir(path.join(root, "core/frontend/host"), { recursive: true });
  await writeFile(
    path.join(root, "modules/probe/module.yaml"),
    `---
schema_version: 1
id: probe
frontend:
  package: "@shep/module-probe"
  path: modules/probe/frontend
  composition_symbol: probeModule
profile: null
tests:
  frontend: null
  backend: null
`,
  );
  await writeFile(
    path.join(root, "modules/probe/frontend/package.json"),
    JSON.stringify({ name: "@shep/module-probe" }),
  );
  await writeFile(
    path.join(root, "core/frontend/host/enabledModules.ts"),
    'import { probeModule } from "@shep/module-probe";\nexport const modules = [probeModule];\n',
  );
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { "@shep/module-probe": "workspace:*" } }),
  );

  assert.deepEqual(validateManifests(root), []);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: {} }));
  assert.match(validateManifests(root).join("\n"), /must depend on @shep\/module-probe/);
});
