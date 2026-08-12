import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultTerminalViewId, isJsonValue, type TerminalId } from "../types.ts";

test("terminal view identity remains distinct from terminal identity", () => {
  const terminalId = "a2450bd2-90df-46a4-a895-65eac3e3701d" as TerminalId;
  assert.equal(defaultTerminalViewId(terminalId), `terminal:${terminalId}`);
});

test("JSON metadata accepts recursively transport-safe values", () => {
  assert.equal(isJsonValue({ string: "value", nested: [null, true, 3.5] }), true);
  assert.equal(isJsonValue(Object.assign(Object.create(null), { safe: "value" })), true);
});

test("JSON metadata rejects values that cannot cross IPC faithfully", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  assert.equal(isJsonValue(undefined), false);
  assert.equal(isJsonValue(Number.NaN), false);
  assert.equal(isJsonValue(Number.POSITIVE_INFINITY), false);
  assert.equal(isJsonValue(() => undefined), false);
  assert.equal(isJsonValue(new Date()), false);
  assert.equal(isJsonValue(cyclic), false);
});
