import assert from "node:assert/strict";
import { test } from "node:test";

import type { TerminalSettings, TerminalSettingsCommit } from "@shipctl/core/platform";
import {
  applyTerminalSettingsCommit,
  formatRetentionBudget,
  RETENTION_DEFAULT_BYTES,
  RETENTION_MAX_BYTES,
  RETENTION_PRESET_BYTES,
  TRANSITIONAL_RENDERER_SCROLLBACK_ROWS,
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

function commit(scrollbackBytes: number, retentionRevision: number): TerminalSettingsCommit {
  return { ...settings(scrollbackBytes), retentionRevision };
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

test("no offered budget is a row count in disguise", () => {
  // The renderer row cap is a separate transitional limit. If a preset ever
  // equals it, the UI would be presenting a row count as a byte budget.
  for (const value of RETENTION_PRESET_BYTES) {
    assert.notEqual(value, TRANSITIONAL_RENDERER_SCROLLBACK_ROWS);
  }
});

test("a newer commit replaces the held policy", () => {
  const held = { settings: settings(0), retentionRevision: 3 };
  const next = applyTerminalSettingsCommit(held, commit(RETENTION_DEFAULT_BYTES, 4));
  assert.equal(next.retentionRevision, 4);
  assert.equal(next.settings.scrollbackBytes, RETENTION_DEFAULT_BYTES);
});

test("a delayed older response cannot roll back a newer committed policy", () => {
  const held = { settings: settings(RETENTION_MAX_BYTES), retentionRevision: 7 };
  const stale = applyTerminalSettingsCommit(held, commit(0, 6));
  assert.equal(stale, held, "a stale response must leave committed state untouched");
});

test("re-reading the same revision is not treated as a rollback", () => {
  const held = { settings: settings(RETENTION_DEFAULT_BYTES), retentionRevision: 7 };
  const reread = applyTerminalSettingsCommit(held, commit(RETENTION_MAX_BYTES, 7));
  assert.equal(reread.retentionRevision, 7);
  assert.equal(reread.settings.scrollbackBytes, RETENTION_MAX_BYTES);
});
