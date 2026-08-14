import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  await mkdir(path.join(root, "ops/version"), { recursive: true });
  await mkdir(path.join(root, "ops/modularity/profiles/probe-disabled"), { recursive: true });

  await writeFile(
    path.join(root, "ops/version/current.yaml"),
    `---\nschema_version: 1\nproduct: shipctl\nproduct_version: ${appVersion}\ndescription: Test version.\n`,
  );

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
    path.join(root, "ops/modularity/profiles/probe-disabled/tauri.conf.json"),
    JSON.stringify({ productName: "shipctl" }),
  );
  return root;
}

test("the YAML authority and matching Tauri projection satisfy the check", async (t) => {
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
    path.join(root, "ops/modularity/profiles/probe-disabled/tauri.conf.json"),
    JSON.stringify({ productName: "shipctl", version: "9.9.9" }),
  );
  assert.match(
    validateVersions(root).join("\n"),
    /^ops\/modularity\/profiles\/probe-disabled\/tauri\.conf\.json: must not override the app version/m,
  );
});

test("the source must be a literal semver", async (t) => {
  const root = await scaffold(t, { appVersion: "../package.json" });
  assert.match(
    validateVersions(root).join("\n"),
    /^ops\/version\/current\.yaml: product_version must be a literal stable semver string/m,
  );
});

test("a missing app version is reported rather than assumed", async (t) => {
  const root = await scaffold(t);
  await writeFile(
    path.join(root, "ops/version/current.yaml"),
    "---\nschema_version: 1\nproduct: shipctl\ndescription: Test.\n",
  );
  assert.match(
    validateVersions(root).join("\n"),
    /^ops\/version\/current\.yaml: must declare product_version/m,
  );
});

test("a stale Tauri packaging projection is reported", async (t) => {
  const root = await scaffold(t);
  await writeFile(
    path.join(root, "src-tauri/tauri.conf.json"),
    JSON.stringify({ productName: "shipctl", version: "9.9.9" }),
  );
  assert.match(
    validateVersions(root).join("\n"),
    /^src-tauri\/tauri\.conf\.json: packaging version "9\.9\.9" must match ops\/version\/current\.yaml "1\.2\.3"/m,
  );
});

test("the source version cannot precede a local stable release tag", async (t) => {
  const root = await scaffold(t, { appVersion: "0.1.0" });
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Shipctl test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "fixture"]);
  execFileSync("git", ["-C", root, "tag", "v0.6.0"]);

  assert.match(
    validateVersions(root).join("\n"),
    /^ops\/version\/current\.yaml: product_version "0\.1\.0" must not precede local release tag v0\.6\.0/m,
  );
});
