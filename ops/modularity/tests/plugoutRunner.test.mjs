import assert from "node:assert/strict";
import { cpSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertSourceAbsent,
  frontendDisabled,
  nativeDisabled,
  prepareSourceAbsent,
  plugout,
  readManifest,
} from "../bin/plugout.mjs";
import { verifyModulePlugout } from "../bin/module-plugout.mjs";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

test("profile runner verifies the current root without materializing a copy", () => {
  const calls = [];
  const root = "/static-contract-root";

  verifyModulePlugout({
    repositoryRoot: root,
    moduleName: "probe",
    verifyEnabled: (actual) => calls.push(["enabled", actual]),
    verifyDisabled: (actual) => calls.push(["disabled", actual]),
    verifySourceAbsent: (actual) => calls.push(["source-absent", actual]),
  });

  assert.deepEqual(calls, [
    ["enabled", root],
    ["disabled", root],
    ["source-absent", root],
  ]);
});

test("profile runner can check only the source-absent contract without a copy", () => {
  const calls = [];

  verifyModulePlugout({
    repositoryRoot,
    moduleName: "probe",
    verifyEnabled: () => calls.push("enabled"),
    verifyDisabled: () => calls.push("disabled"),
    verifySourceAbsent: () => calls.push("source-absent"),
    sourceAbsentOnly: true,
  });

  assert.deepEqual(calls, ["source-absent"]);
});

test("public profile commands use manifest and composition contracts without builds", () => {
  plugout(repositoryRoot, "commands");
  frontendDisabled(repositoryRoot, "commands");
  nativeDisabled(repositoryRoot, "todos");
});

function copy(root, relativePath) {
  const source = path.join(repositoryRoot, relativePath);
  if (!existsSync(source)) return;
  const target = path.join(root, relativePath);
  cpSync(source, target, { recursive: true });
}

for (const id of ["todos", "ports", "skills", "git", "commands", "assistants", "usage", "fixture"]) {
  test(`manifest removes the ${id} module from every declaration site`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), `shipctl-${id}-transform-`));
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
      "src-tauri/src/lib.rs",
      "src-tauri/src/modules/git.rs",
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
