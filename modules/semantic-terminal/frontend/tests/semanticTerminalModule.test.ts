import assert from "node:assert/strict";
import test from "node:test";

import {
  SEMANTIC_TERMINAL_DRIVER_ID,
  semanticTerminalModule,
} from "../src/index.ts";

test("semantic terminal contributes exactly its semantic presentation", () => {
  assert.equal(semanticTerminalModule.id, "shipctl.semantic-terminal");
  assert.deepEqual(
    semanticTerminalModule.terminalPresentations.map((provider) => provider.driverId),
    [SEMANTIC_TERMINAL_DRIVER_ID],
  );
});
