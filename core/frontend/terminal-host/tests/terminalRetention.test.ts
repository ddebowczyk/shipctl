import assert from "node:assert/strict";
import { test } from "node:test";

import type { TerminalSettings } from "@shipctl/core/configuration";
import type { TerminalRetentionCommit } from "@shipctl/core/platform";
import {
  applyTerminalRetentionCommit,
  formatRetentionBudget,
  RETENTION_DEFAULT_BYTES,
  RETENTION_MAX_BYTES,
  RETENTION_PRESET_BYTES,
} from "../terminalRetention.ts";

function settings(scrollbackBytes: number): TerminalSettings {
  return {
    cursorStyle: "block",
    cursorBlink: true,
    scrollbackBytes,
    fontFamily: "MesloLGS NF",
    fontSize: 14,
    urlAllowlist: ["http", "https"],
    confirmUnsafePaste: false,
  };
}

function commit(retentionBytes: number, retentionRevision: number): TerminalRetentionCommit {
  return { retentionBytes, retentionRevision };
}

test("every offered budget is inside the domain the backend clamps to", () => {
  for (const value of RETENTION_PRESET_BYTES) {
    assert.ok(value >= 0 && value <= RETENTION_MAX_BYTES, `${value} is outside the domain`);
  }
  assert.ok(RETENTION_PRESET_BYTES.includes(RETENTION_DEFAULT_BYTES));
});

test("a zero budget is described as no history, not as a small one", () => {
  assert.equal(formatRetentionBudget(0), "None");
  assert.equal(formatRetentionBudget(RETENTION_DEFAULT_BYTES), "16 MB");
});

test("a newer resource acknowledgement advances the held revision", () => {
  const held = { settings: settings(0), retentionRevision: 3 };
  const next = applyTerminalRetentionCommit(held, commit(RETENTION_DEFAULT_BYTES, 4));
  assert.equal(next.retentionRevision, 4);
  assert.equal(next.settings, held.settings);
});

test("a delayed older response cannot roll back a newer committed policy", () => {
  const held = { settings: settings(RETENTION_MAX_BYTES), retentionRevision: 7 };
  const stale = applyTerminalRetentionCommit(held, commit(0, 6));
  assert.equal(stale, held, "a stale response must leave committed state untouched");
});

test("re-reading the same revision does not replace TypeScript-owned settings", () => {
  const held = { settings: settings(RETENTION_DEFAULT_BYTES), retentionRevision: 7 };
  const reread = applyTerminalRetentionCommit(held, commit(RETENTION_MAX_BYTES, 7));
  assert.equal(reread.retentionRevision, 7);
  assert.equal(reread.settings, held.settings);
});
