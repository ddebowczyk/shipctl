import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateVersions } from "../bin/check-version.mjs";

async function scaffold(t, { appVersion = "1.2.3" } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "shipctl-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src-tauri"), { recursive: true });
  await mkdir(path.join(root, "core/backend"), { recursive: true });
  await mkdir(path.join(root, "profiles/probe-disabled"), { recursive: true });

  await writeFile(
    path.join(root, "src-tauri/tauri.conf.json"),
    JSON.stringify({ productName: "shipctl", version: appVersion }),
  );
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "shipctl", version: "0.0.0" }));
  await writeFile(path.join(root, "Cargo.toml"), '[workspace]\nmembers = ["src-tauri"]\n');
  await writeFile(path.join(root, "src-tauri/Cargo.toml"), '[package]\nname = "shipctl"\nversion = "0.0.0"\n');
  await writeFile(
    path.join(root, "core/backend/Cargo.toml"),
    '[package]\nname = "shipctl-core"\nversion = "0.0.0"\n',
  );
  await writeFile(
    path.join(root, "profiles/probe-disabled/tauri.conf.json"),
    JSON.stringify({ productName: "shipctl" }),
  );
  return root;
}

test("a single declaration in the Tauri config satisfies the check", async (t) => {
  const root = await scaffold(t);
  assert.deepEqual(validateVersions(root), []);
});

test("a second manifest claiming the app version is drift", async (t) => {
  const root = await scaffold(t);

  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "shipctl", version: "1.2.3" }));
  assert.match(validateVersions(root).join("\n"), /^package\.json: version must be 0\.0\.0/m);

  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "shipctl", version: "0.0.0" }));
  await writeFile(path.join(root, "src-tauri/Cargo.toml"), '[package]\nname = "shipctl"\nversion = "1.2.3"\n');
  assert.match(validateVersions(root).join("\n"), /^src-tauri\/Cargo\.toml: version must be 0\.0\.0/m);
});

test("a workspace-inherited crate version is drift", async (t) => {
  const root = await scaffold(t);
  await writeFile(
    path.join(root, "Cargo.toml"),
    '[workspace]\nmembers = ["src-tauri"]\n\n[workspace.package]\nversion = "1.2.3"\n',
  );
  await writeFile(
    path.join(root, "src-tauri/Cargo.toml"),
    "[package]\nname = \"shipctl\"\nversion.workspace = true\n",
  );

  const failures = validateVersions(root).join("\n");
  assert.match(failures, /^Cargo\.toml: \[workspace\.package\] must not declare a version/m);
  assert.match(failures, /^src-tauri\/Cargo\.toml: version must not be inherited/m);
});

test("a profile overlay may not override the app version", async (t) => {
  const root = await scaffold(t);
  await writeFile(
    path.join(root, "profiles/probe-disabled/tauri.conf.json"),
    JSON.stringify({ productName: "shipctl", version: "9.9.9" }),
  );
  assert.match(
    validateVersions(root).join("\n"),
    /^profiles\/probe-disabled\/tauri\.conf\.json: must not override the app version/m,
  );
});

test("the source must be a literal semver, not a package.json path", async (t) => {
  // Tauri accepts a path here but resolves it against the caller's working
  // directory, so the same config would yield different versions per tool.
  const root = await scaffold(t, { appVersion: "../package.json" });
  assert.match(
    validateVersions(root).join("\n"),
    /^src-tauri\/tauri\.conf\.json: version must be a literal semver string/m,
  );
});

test("a missing app version is reported rather than assumed", async (t) => {
  const root = await scaffold(t);
  await writeFile(path.join(root, "src-tauri/tauri.conf.json"), JSON.stringify({ productName: "shipctl" }));
  assert.match(
    validateVersions(root).join("\n"),
    /^src-tauri\/tauri\.conf\.json: must declare the app version/m,
  );
});
