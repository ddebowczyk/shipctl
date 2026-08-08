import assert from "node:assert/strict";
import test from "node:test";

import { runLoaderTripwire } from "../bin/loader-tripwire.mjs";

test("loader tripwire verifies artifact swaps without a source rebuild", async () => {
  const result = await runLoaderTripwire({ packaged: false });

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.observed.loadedA.marker, "A");
  assert.equal(result.observed.markerAfterSwap, "B");
  assert.equal(result.observed.loadedA.reactSingleton, true);
  assert.equal(result.observed.loadedB.reactSingleton, true);
  assert.deepEqual(result.observed.failedC.code, "module.loader.import_failed");
  assert.equal(result.observed.usableAfterC.marker, "B");
  assert.equal(result.observed.defaultStateUntouched, true);
  assert.equal(result.productionBoundary.csp.assetProtocolEnabled, true);
  assert.equal(result.productionBoundary.csp.staticScopeIsEmpty, true);
  assert.equal(result.productionBoundary.csp.scriptSrcAllowsAsset, true);
  assert.equal(result.productionBoundary.csp.dynamicScopeIsArtifactRoot, true);
  assert.equal(result.productionBoundary.csp.dynamicScopeDoesNotGrantStateRoot, true);
  assert.equal(result.productionBoundary.packagedWebview.status, "not_requested");
});
