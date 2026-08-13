import assert from "node:assert/strict";
import test from "node:test";

import {
  compareStableVersions,
  latestStableVersion,
  nextStableVersion,
  STABLE_SEMVER,
} from "../bin/release-history.mjs";

test("stable SemVer comparison does not use unsafe JavaScript numbers", () => {
  assert.equal(compareStableVersions("0.10.0", "0.9.99"), 1);
  assert.equal(compareStableVersions("9007199254740993.0.0", "9007199254740992.999.999"), 1);
  assert.equal(compareStableVersions("1.0.0", "1.0.0"), 0);
});

test("the stable version grammar rejects leading zero and prerelease values", () => {
  assert.equal(STABLE_SEMVER.test("0.7.0"), true);
  assert.equal(STABLE_SEMVER.test("00.7.0"), false);
  assert.equal(STABLE_SEMVER.test("0.7.0-rc.1"), false);
});

test("next version and release selection use SemVer ordering", () => {
  assert.equal(nextStableVersion("0.6.9", "patch"), "0.6.10");
  assert.equal(nextStableVersion("0.6.9", "minor"), "0.7.0");
  assert.equal(nextStableVersion("0.6.9", "major"), "1.0.0");
  assert.equal(latestStableVersion(["0.6.0", "0.10.0", "invalid"]), "0.10.0");
});
