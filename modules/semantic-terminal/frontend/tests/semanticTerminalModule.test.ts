import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SEMANTIC_TERMINAL_DRIVER_ID,
  SEMANTIC_TERMINAL_MODULE_ID,
  SEMANTIC_TERMINAL_REQUIRED_GRANTS,
  semanticTerminalContributions,
} from "../src/index.ts";

test("semantic terminal contributes exactly its direct semantic presentation", () => {
  assert.equal(SEMANTIC_TERMINAL_MODULE_ID, "shipctl.semantic-terminal");
  assert.deepEqual(SEMANTIC_TERMINAL_REQUIRED_GRANTS, [
    "terminal.attach",
    "terminal.input",
    "terminal.resize",
    "semantic-terminal.attach",
    "semantic-terminal.input",
    "semantic-terminal.inspect",
  ]);
  assert.equal(
    semanticTerminalContributions.terminalPresentations[0]?.moduleId,
    SEMANTIC_TERMINAL_MODULE_ID,
  );
  assert.deepEqual(
    semanticTerminalContributions.terminalPresentations.map((provider) => provider.driverId),
    [SEMANTIC_TERMINAL_DRIVER_ID],
  );
  assert.deepEqual(
    semanticTerminalContributions.terminalPresentations[0]?.requiredServices.map(
      ({ id, version }) => ({ id, version }),
    ),
    [
      { id: "shipctl.terminal-sessions", version: 1 },
      { id: "shipctl.semantic-terminals", version: 1 },
    ],
  );
});

test("semantic terminal source has no static ShipctlModule compatibility object", () => {
  const source = readFileSync(new URL("../src/pluginContributions.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /\bShipctlModule\b|\bsemanticTerminalModule\b/);
});
