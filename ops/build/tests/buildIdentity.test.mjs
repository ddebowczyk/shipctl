import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { hashTree } from "../bin/hash-tree.mjs";
import { sourceIdentity } from "../bin/source-identity.mjs";

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

test("source identity distinguishes dirty content and ignores build output", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "shipctl-source-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.email", "shipctl-test@example.invalid");
  git(root, "config", "user.name", "Shipctl Test");
  await writeFile(path.join(root, ".gitignore"), "builds/\n");
  await writeFile(path.join(root, "tracked.txt"), "one\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");

  const clean = sourceIdentity(root);
  assert.equal(clean.dirty, false);

  await writeFile(path.join(root, "tracked.txt"), "two\n");
  const firstDirty = sourceIdentity(root);
  assert.equal(firstDirty.dirty, true);
  assert.notEqual(firstDirty.fingerprint, clean.fingerprint);

  await mkdir(path.join(root, "builds"));
  await writeFile(path.join(root, "builds/generated.bin"), "ignored\n");
  assert.equal(sourceIdentity(root).fingerprint, firstDirty.fingerprint);

  await writeFile(path.join(root, "tracked.txt"), "three\n");
  assert.notEqual(sourceIdentity(root).fingerprint, firstDirty.fingerprint);

  await writeFile(path.join(root, "untracked.txt"), "first\n");
  const untracked = sourceIdentity(root).fingerprint;
  await writeFile(path.join(root, "untracked.txt"), "second\n");
  assert.notEqual(sourceIdentity(root).fingerprint, untracked);
});

test("artifact tree hashing covers content, paths, modes, and symlink targets", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "shipctl-artifact-tree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "Contents/MacOS"), { recursive: true });
  await writeFile(path.join(root, "Contents/MacOS/shipctl"), "first\n", { mode: 0o755 });
  await symlink("shipctl", path.join(root, "Contents/MacOS/current"));
  const original = hashTree(root);

  await writeFile(path.join(root, "Contents/MacOS/shipctl"), "second\n", { mode: 0o755 });
  assert.notEqual(hashTree(root), original);
});
