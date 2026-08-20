import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  THIN_TERMINAL_DRIVER_ID,
  THIN_TERMINAL_MODULE_ID,
  THIN_TERMINAL_REQUIRED_GRANTS,
  thinTerminalContributions,
} from "../src/index.ts";

test("thin terminal contributes exactly its direct raw-byte presentation", () => {
  assert.equal(THIN_TERMINAL_MODULE_ID, "shipctl.thin-terminal");
  assert.deepEqual(THIN_TERMINAL_REQUIRED_GRANTS, [
    "terminal.attach",
    "terminal.input",
    "terminal.resize",
  ]);
  assert.equal(
    thinTerminalContributions.terminalPresentations[0]?.moduleId,
    THIN_TERMINAL_MODULE_ID,
  );
  assert.deepEqual(
    thinTerminalContributions.terminalPresentations.map((provider) => provider.driverId),
    [THIN_TERMINAL_DRIVER_ID],
  );
});

test("thin terminal source has no static ShipctlModule compatibility object", () => {
  const source = readFileSync(new URL("../src/pluginContributions.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /\bShipctlModule\b|\bthinTerminalModule\b/);
});
