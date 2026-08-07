import assert from "node:assert/strict";
import { cpSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertSourceAbsent,
  prepareSourceAbsent,
  readManifest,
} from "../bin/plugout.mjs";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function copy(root, relativePath) {
  const source = path.join(repositoryRoot, relativePath);
  if (!existsSync(source)) return;
  const target = path.join(root, relativePath);
  cpSync(source, target, { recursive: true });
}

for (const id of ["todos", "ports", "skills", "git", "commands", "assistants", "usage", "fixture"]) {
  test(`manifest removes the ${id} module from every declaration site`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), `shep-${id}-transform-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const directory of [
      "core/frontend/host",
      "src-tauri/src/modules",
      "scripts",
      "ops/modularity/fixtures/panel-host",
    ]) {
      await mkdir(path.join(root, directory), { recursive: true });
    }
    for (const relativePath of [
      "core/frontend/host/enabledModules.ts",
      "src-tauri/Cargo.toml",
      "src-tauri/src/modules/mod.rs",
      "src-tauri/tauri.conf.json",
      "profiles",
      `modules/${id}`,
      "package.json",
      "ops/modularity/fixtures/panel-host/main.tsx",
    ]) {
      copy(root, relativePath);
    }
    const manifest = readManifest(repositoryRoot, id);
    const packageStem = manifest.frontend.package.split("/").at(-1);
    copy(root, `scripts/verify-${packageStem}-plugout.mjs`);
    if (manifest.profile && !manifest.profile.includes("-disabled/")) {
      copy(root, "ops/modularity/fixtures/module-fixture");
    }
    for (const hostGlue of manifest.backend?.host_glue ?? []) copy(root, hostGlue);

    prepareSourceAbsent(root, manifest);
    assertSourceAbsent(root, manifest);

    assert.equal(existsSync(path.join(root, `modules/${id}`)), false);
    if (manifest.profile) {
      assert.equal(existsSync(path.join(root, path.dirname(manifest.profile))), false);
    }
    for (const hostGlue of manifest.backend?.host_glue ?? []) {
      assert.equal(existsSync(path.join(root, hostGlue)), false);
    }
  });
}
