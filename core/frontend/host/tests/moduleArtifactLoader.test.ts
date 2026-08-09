import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDigestQualifiedArtifactUrl,
  loadShipctlModuleArtifact,
  moduleArtifactUrl,
  ModuleArtifactLoadError,
} from "../moduleArtifactLoader.ts";

const DIGEST_A = "a".repeat(64);
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

test("restart-bound loader accepts only the admitted headless module identity", async () => {
  const module = {
    id: "test.headless-module",
    version: "1.0.0",
    messages: { provides: [] },
  };
  const loaded = await loadShipctlModuleArtifact({
    digest: DIGEST_A,
    entryUrl: `asset://localhost/modules/${DIGEST_A}/module.mjs`,
    expectedModuleId: module.id,
    expectedVersion: module.version,
    importModule: async () => ({ createShipctlModule: () => module }),
  });
  assert.equal(loaded.module, module);

  await assert.rejects(
    () => loadShipctlModuleArtifact({
      digest: DIGEST_A,
      entryUrl: `asset://localhost/modules/${DIGEST_A}/module.mjs`,
      expectedModuleId: module.id,
      expectedVersion: module.version,
      importModule: async () => ({
        createShipctlModule: () => ({ ...module, panels: [] }),
      }),
    }),
    (error: unknown) => error instanceof ModuleArtifactLoadError
      && error.code === "module.loader.invalid_artifact",
  );
});
