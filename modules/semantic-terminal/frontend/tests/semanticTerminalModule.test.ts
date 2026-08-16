import assert from "node:assert/strict";
import test from "node:test";

import {
  SEMANTIC_TERMINAL_DRIVER_ID,
  semanticTerminalModule,
} from "../src/index.ts";

test("semantic terminal contributes exactly its semantic presentation", () => {
  assert.equal(semanticTerminalModule.id, "shipctl.semantic-terminal");
  assert.deepEqual(semanticTerminalModule.requiredGrants, [
    "terminal.attach",
    "terminal.input",
    "terminal.resize",
    "semantic-terminal.attach",
    "semantic-terminal.input",
    "semantic-terminal.inspect",
  ]);
  assert.equal(
    semanticTerminalModule.terminalPresentations[0]?.moduleId,
    semanticTerminalModule.id,
  );
  assert.deepEqual(
    semanticTerminalModule.terminalPresentations.map((provider) => provider.driverId),
    [SEMANTIC_TERMINAL_DRIVER_ID],
  );
  assert.deepEqual(
    semanticTerminalModule.terminalPresentations[0]?.requiredServices.map(
      ({ id, version }) => ({ id, version }),
    ),
    [
      { id: "shipctl.terminal-sessions", version: 1 },
      { id: "shipctl.semantic-terminals", version: 1 },
    ],
  );
});
