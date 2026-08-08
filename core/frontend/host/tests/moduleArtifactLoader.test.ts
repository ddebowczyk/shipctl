import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  assertDigestQualifiedArtifactUrl,
  loadModuleArtifact,
  moduleArtifactUrl,
  ModuleArtifactLoadError,
} from "../moduleArtifactLoader.ts";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

async function artifact(root: string, digest: string, source: string): Promise<string> {
  const entry = path.join(root, "shipctl.fixture", "0.0.0", digest, "module.mjs");
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, source, "utf8");
  return pathToFileURL(entry).href;
}

test("digest-qualified artifacts switch markers while sharing the host React singleton", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "shipctl-module-loader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = (marker: string) => [
    `export const runtimeMarker = ${JSON.stringify(marker)};`,
    "export function activate(host) { return { marker: runtimeMarker, react: host.react }; }",
  ].join("\n");
  const a = await artifact(root, DIGEST_A, source("A"));
  const b = await artifact(root, DIGEST_B, source("B"));

  const loadedA = await loadModuleArtifact({ digest: DIGEST_A, entryUrl: a });
  const loadedB = await loadModuleArtifact({ digest: DIGEST_B, entryUrl: b });

  assert.equal(loadedA.marker, "A");
  assert.equal(loadedB.marker, "B");
  assert.equal(loadedA.runtime.react, loadedB.runtime.react);
});

test("failed imports report their phase and leave the preceding artifact usable", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "shipctl-module-loader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const good = await artifact(
    root,
    DIGEST_B,
    'export const runtimeMarker = "B"; export function activate(host) { return { marker: runtimeMarker, react: host.react }; }',
  );
  const broken = await artifact(root, DIGEST_C, 'throw new Error("fixture C import failure");');

  assert.equal((await loadModuleArtifact({ digest: DIGEST_B, entryUrl: good })).marker, "B");
  await assert.rejects(
    () => loadModuleArtifact({ digest: DIGEST_C, entryUrl: broken }),
    (error: unknown) => error instanceof ModuleArtifactLoadError
      && error.phase === "import"
      && error.code === "module.loader.import_failed",
  );
  assert.equal((await loadModuleArtifact({ digest: DIGEST_B, entryUrl: good })).marker, "B");
});

test("the production URL adapter only accepts the requested immutable directory", () => {
  const entryPath = `/isolated/modules/shipctl.fixture/0.0.0/${DIGEST_A}/module.mjs`;
  assert.equal(
    moduleArtifactUrl(entryPath, DIGEST_A, (file) => `asset://localhost/${encodeURIComponent(file)}`),
    `asset://localhost/${encodeURIComponent(entryPath)}`,
  );
  assert.throws(
    () => assertDigestQualifiedArtifactUrl("asset://localhost/other/module.mjs", DIGEST_A),
    (error: unknown) => error instanceof ModuleArtifactLoadError && error.phase === "resolve",
  );
});
