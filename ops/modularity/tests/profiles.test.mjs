import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { profileDrift } from "../bin/profiles.mjs";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

test("committed disabled profiles are byte-identical to manifest-derived output", () => {
  assert.deepEqual(profileDrift(repositoryRoot), []);
});
