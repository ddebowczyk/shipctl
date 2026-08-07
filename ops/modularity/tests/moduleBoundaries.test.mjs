import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkModuleBoundaries, formatDiagnostics } from "../bin/check-module-boundaries.mjs";

async function fixture(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "shep-module-boundaries-"));
  await mkdir(path.join(root, "core/frontend/host"), { recursive: true });
  await writeFile(
    path.join(root, "core/frontend/package.json"),
    JSON.stringify({
      name: "@shep/core",
      exports: {
        "./platform": "./platform/index.ts",
        "./shared": "./shared/index.ts",
        "./alpha": "./alpha/index.ts",
      },
    }),
  );
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
    "core/frontend/host/enabledModules.ts": "import alpha from '@shep/alpha'; export default alpha;",
    "src/main.tsx": "import type { ShepModule } from '@shep/module-api'; export type T = ShepModule;",
    "modules/alpha/frontend/src/index.ts": "import type { ShepModule } from '@shep/module-api'; export const value: ShepModule | null = null;",
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await checkModuleBoundaries(root), []);
});

test("reports deterministic host and sibling violations", async (t) => {
  const root = await fixture({
    "src/main.tsx": "import alpha from '@shep/alpha'; export default alpha;",
    "core/frontend/host/enabledModules.ts": "import x from '@shep/alpha/src/internal'; export default x;",
    "modules/alpha/frontend/src/index.ts": "import beta from '@shep/beta'; export default beta;",
    "modules/beta/frontend/src/index.ts": "import host from '../../../../src/main'; export default host;",
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const diagnostics = await checkModuleBoundaries(root);
  assert.deepEqual(
    diagnostics.map(({ rule }) => rule),
    [
      "host-module-deep-import",
      "module-sibling-import",
      "module-host-import",
      "host-module-import-outside-composition",
    ],
  );
  assert.match(formatDiagnostics(diagnostics), /src\/main\.tsx:1:\d+ \[host-module-import-outside-composition\]/);
});

test("rejects a cross-capability deep import probe", async (t) => {
  const root = await fixture({
    "core/frontend/alpha/index.ts": "export const value = 1;",
    "core/frontend/alpha/internal.ts": "export const secret = 1;",
    "core/frontend/beta/probe.ts": "import { secret } from '../alpha/internal.ts'; export { secret };",
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const diagnostics = await checkModuleBoundaries(root);
  assert.deepEqual(diagnostics.map(({ rule }) => rule), ["core-capability-deep-import"]);
  assert.match(formatDiagnostics(diagnostics), /core\/frontend\/beta\/probe\.ts:1:\d+/);
});

test("rejects capability code in src and application imports into ops", async (t) => {
  const root = await fixture({
    "src/main.tsx": "import '../ops/release.ts';",
    "src/vite-env.d.ts": "/// <reference types='vite/client' />",
    "src/leftover.ts": "export const leftover = true;",
    "modules/alpha/frontend/src/index.ts": "import '../../../../ops/release.ts';",
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const diagnostics = await checkModuleBoundaries(root);
  assert.deepEqual(
    diagnostics.map(({ rule }) => rule),
    ["app-ops-import", "src-entry-only", "app-ops-import"],
  );
});
