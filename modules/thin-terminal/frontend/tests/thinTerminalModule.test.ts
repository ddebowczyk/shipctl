import assert from "node:assert/strict";
import test from "node:test";

import { THIN_TERMINAL_DRIVER_ID, thinTerminalModule } from "../src/index.ts";

test("thin terminal contributes exactly its raw-byte presentation", () => {
  assert.equal(thinTerminalModule.id, "shipctl.thin-terminal");
  assert.deepEqual(
    thinTerminalModule.terminalPresentations.map((provider) => provider.driverId),
    [THIN_TERMINAL_DRIVER_ID],
  );
});
