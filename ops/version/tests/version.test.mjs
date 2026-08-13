import assert from "node:assert/strict";
import test from "node:test";

import { replaceTauriProductVersion, replaceYamlProductVersion } from "../bin/version.mjs";

test("version projection updates preserve all unrelated YAML and JSON text", () => {
  const yaml = "---\nproduct_version: 0.1.0\ndescription: >-\n  Keep this line\n";
  const json = '{\n  "productName": "shipctl",\n  "version": "0.1.0",\n  "windows": ["main"]\n}\n';

  assert.equal(
    replaceYamlProductVersion(yaml, "0.7.0"),
    "---\nproduct_version: 0.7.0\ndescription: >-\n  Keep this line\n",
  );
  assert.equal(
    replaceTauriProductVersion(json, "0.7.0"),
    '{\n  "productName": "shipctl",\n  "version": "0.7.0",\n  "windows": ["main"]\n}\n',
  );
});

test("version projection replacement refuses ambiguous source files", () => {
  assert.throws(
    () => replaceYamlProductVersion("product_version: 0.1.0\nproduct_version: 0.2.0\n", "0.7.0"),
    /exactly one product_version field/,
  );
  assert.throws(
    () => replaceTauriProductVersion('{ "version": "0.1.0" }\n', "0.7.0"),
    /exactly one Tauri version field/,
  );
});
