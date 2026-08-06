import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkModuleBoundaries, formatDiagnostics } from "../check-module-boundaries.mjs";

async function fixture(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "shep-module-boundaries-"));
  await mkdir(path.join(root, "src/core/modules"), { recursive: true });
  for (const moduleName of ["api", "alpha", "beta"]) {
    const frontend = path.join(root, "modules", moduleName, "frontend");
    await mkdir(path.join(frontend, "src"), { recursive: true });
    const packageName = moduleName === "api" ? "@shep/module-api" : `@shep/${moduleName}`;
    await writeFile(path.join(frontend, "package.json"), JSON.stringify({ name: packageName }));
  }
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}

test("accepts public composition and inward API imports", async (t) => {
  const root = await fixture({
    "src/core/modules/enabledModules.ts": "import alpha from '@shep/alpha'; export default alpha;",
    "src/host.ts": "import type { ShepModule } from '@shep/module-api'; export type T = ShepModule;",
    "modules/alpha/frontend/src/index.ts": "import type { ShepModule } from '@shep/module-api'; export const value: ShepModule | null = null;",
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await checkModuleBoundaries(root), []);
});

test("reports deterministic host and sibling violations", async (t) => {
  const root = await fixture({
    "src/host.ts": "import alpha from '@shep/alpha'; export default alpha;",
    "src/core/modules/enabledModules.ts": "import x from '@shep/alpha/src/internal'; export default x;",
    "modules/alpha/frontend/src/index.ts": "import beta from '@shep/beta'; export default beta;",
    "modules/beta/frontend/src/index.ts": "import host from '../../../../src/host'; export default host;",
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const diagnostics = await checkModuleBoundaries(root);
  assert.deepEqual(
    diagnostics.map(({ rule }) => rule),
    [
      "module-sibling-import",
      "module-host-import",
      "host-module-deep-import",
      "host-module-import-outside-composition",
    ],
  );
  assert.match(formatDiagnostics(diagnostics), /src\/host\.ts:1:\d+ \[host-module-import-outside-composition\]/);
});
