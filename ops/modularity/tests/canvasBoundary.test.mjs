import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { checkModuleBoundaries } from "../bin/check-module-boundaries.mjs";

async function fixture(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "shipctl-canvas-boundaries-"));
  await mkdir(path.join(root, "core/frontend/canvas"), { recursive: true });
  await writeFile(
    path.join(root, "core/frontend/package.json"),
    JSON.stringify({
      name: "@shipctl/core",
      exports: {
        "./canvas": "./canvas/index.ts",
        "./platform": "./platform/index.ts",
      },
    }),
  );
  for (const [relativeRoot, packageName] of [
    ["module-api/frontend", "@shipctl/module-api"],
    ["modules/git/frontend", "@shipctl/module-git"],
    ["modules/alpha/frontend", "@shipctl/module-alpha"],
  ]) {
    const frontend = path.join(root, relativeRoot);
    await mkdir(path.join(frontend, "src"), { recursive: true });
    await writeFile(path.join(frontend, "package.json"), JSON.stringify({ name: packageName }));
  }
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}

test("the real canvas boundary is clean", async () => {
  assert.deepEqual(await checkModuleBoundaries(process.cwd()), []);
});

test("canvas rejects feature and Tauri imports while modules cannot import canvas", async (t) => {
  const root = await fixture({
    "core/frontend/canvas/Canvas.ts": [
      "import git from '@shipctl/module-git';",
      "import { getCurrentWindow } from '@tauri-apps/api/window';",
      "export default [git, getCurrentWindow];",
    ].join("\n"),
    "modules/alpha/frontend/src/index.ts": "import canvas from '@shipctl/core/canvas'; export default canvas;",
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const diagnostics = await checkModuleBoundaries(root);
  assert.deepEqual(
    diagnostics.map(({ rule, specifier }) => ({ rule, specifier })),
    [
      { rule: "canvas-feature-module-import", specifier: "@shipctl/module-git" },
      { rule: "tauri-import-outside-platform", specifier: "@tauri-apps/api/window" },
      { rule: "module-host-import", specifier: "@shipctl/core/canvas" },
    ],
  );
});
