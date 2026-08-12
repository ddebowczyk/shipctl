import assert from "node:assert/strict";
import { test } from "node:test";

import {
  disposeTerminalModel,
  terminalModel,
} from "@shipctl/module-semantic-terminal";

test("a semantic model survives presentation reuse and is replaced only after disposal", () => {
  const first = terminalModel("terminal-cache-test");
  assert.equal(terminalModel("terminal-cache-test"), first);

  disposeTerminalModel("terminal-cache-test");

  const replacement = terminalModel("terminal-cache-test");
  assert.notEqual(replacement, first);
  disposeTerminalModel("terminal-cache-test");
});
