import assert from "node:assert/strict";
import test from "node:test";

import {
  terminalDriverId,
  type TerminalPresentationProvider,
} from "@shipctl/module-api";

import {
  TerminalPresentationRegistry,
  terminalPresentationRegistry,
} from "../terminalPresentationRegistry.ts";

const thin: TerminalPresentationProvider = {
  driverId: terminalDriverId("thin-terminal"),
  Presentation: () => null,
};

const semantic: TerminalPresentationProvider = {
  driverId: terminalDriverId("semantic-terminal"),
  Presentation: () => null,
};

test("registry resolves semantic and TTY presentations side by side", () => {
  const registry = new TerminalPresentationRegistry([semantic, thin]);

  assert.equal(registry.resolve(semantic.driverId), semantic);
  assert.equal(registry.resolve(thin.driverId), thin);
  assert.deepEqual(new Set(registry.ids()), new Set([semantic.driverId, thin.driverId]));
});

test("registry resolves one installed presentation by selected driver", () => {
  const registry = terminalPresentationRegistry([{ terminalPresentations: [thin] }]);
  assert.equal(registry.resolve(thin.driverId), thin);
  assert.equal(registry.resolve(terminalDriverId("semantic-terminal")), null);
});

test("registry rejects duplicate terminal driver ids", () => {
  assert.throws(
    () => new TerminalPresentationRegistry([thin, thin]),
    /Duplicate terminal presentation provider: thin-terminal/,
  );
});

test("registry rejects an unavailable selected driver", () => {
  const registry = new TerminalPresentationRegistry([thin]);
  assert.throws(
    () => registry.require(terminalDriverId("semantic-terminal")),
    /Terminal driver is not installed: semantic-terminal/,
  );
});
