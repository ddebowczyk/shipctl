import assert from "node:assert/strict";
import { test } from "node:test";

import { resizedStandardWorkspaceNavigationWidth } from "../standardWorkspaceNavigationSizing.ts";

test("left navigation resizing follows its right edge and stays within live layout bounds", () => {
  assert.equal(resizedStandardWorkspaceNavigationWidth(288, 300, 400, 900), 388);
  assert.equal(resizedStandardWorkspaceNavigationWidth(288, 300, -100, 900), 1);
  assert.equal(resizedStandardWorkspaceNavigationWidth(288, 300, 1200, 900), 900);
});
