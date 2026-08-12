import assert from "node:assert/strict";
import { test } from "node:test";

import { parseOscNotificationMessage } from "@shipctl/module-thin-terminal";

test("a bare payload is the message", () => {
  assert.equal(parseOscNotificationMessage("Build finished"), "Build finished");
});

test("the 2; form carries the message after the prefix", () => {
  assert.equal(parseOscNotificationMessage("2;Build finished"), "Build finished");
});

test("an empty payload is not a notification", () => {
  assert.equal(parseOscNotificationMessage(""), null);
  assert.equal(parseOscNotificationMessage("2;"), null);
});

test("only a leading prefix is stripped", () => {
  // A message that mentions the prefix later keeps it.
  assert.equal(parseOscNotificationMessage("done 2;now"), "done 2;now");
  // And a doubled prefix loses exactly one.
  assert.equal(parseOscNotificationMessage("2;2;x"), "2;x");
});

test("a message that is only whitespace still notifies", () => {
  // Whitespace is a payload the agent chose to send; it is not the empty
  // payload the handler treats as absent.
  assert.equal(parseOscNotificationMessage("2; "), " ");
});
