import assert from "node:assert/strict";
import test from "node:test";

import { buildFlavor } from "../bin/build-flavor.mjs";

const BUILD_ID = "b20260815T163000.000Z-ga39e91cc128c-tef5e0fa22dc3-aarch64-apple-darwin";

test("preview bundles cannot impersonate the installed application", () => {
  const preview = buildFlavor("preview", BUILD_ID);

  assert.equal(preview.appName, "shipctl-preview");
  assert.equal(preview.appBundleName, "shipctl-preview.app");
  assert.equal(
    preview.bundleIdentifier,
    "com.cognesy.shipctl.preview.b20260815T163000-000Z-ga39e91cc128c-tef5e0fa22dc3-aarch64-apple-darwin",
  );
  assert.equal(preview.tauriConfig.productName, preview.appName);
  assert.equal(preview.tauriConfig.identifier, preview.bundleIdentifier);
  assert.equal(preview.tauriConfig.bundle.macOS.signingIdentity, "-");
});

test("package bundles retain the stable Shipctl release identity", () => {
  const packaged = buildFlavor("package", BUILD_ID);

  assert.equal(packaged.appName, "shipctl");
  assert.equal(packaged.appBundleName, "shipctl.app");
  assert.equal(packaged.bundleIdentifier, "com.cognesy.shipctl");
});

test("preview identity refuses arbitrary build labels", () => {
  assert.throws(
    () => buildFlavor("preview", "not-a-build-id"),
    /Invalid build ID/,
  );
});
