import assert from "node:assert/strict";
import { test } from "node:test";

import type { TerminalTabData } from "@shipctl/core/platform";
import { shouldAutoCloseBlankTerminal } from "../terminalExitPolicy.ts";

function tab(overrides: Partial<TerminalTabData> = {}): TerminalTabData {
  return {
    id: "terminal-1",
    kind: "terminal",
    label: "Terminal",
    ptyId: 41,
    repoPath: "/fixture",
    commandName: null,
    ...overrides,
  };
}

test("only a successful blank shell naturally closes its terminal tab", () => {
  assert.equal(shouldAutoCloseBlankTerminal(tab(), 0), true);
  assert.equal(shouldAutoCloseBlankTerminal(tab(), 1), false);
  assert.equal(shouldAutoCloseBlankTerminal(undefined, 0), false);
});

test("saved commands and module sessions retain their completion semantics", () => {
  assert.equal(
    shouldAutoCloseBlankTerminal(tab({ commandName: "dev" }), 0),
    false,
  );
  assert.equal(
    shouldAutoCloseBlankTerminal(tab({ moduleSessionId: "assistant-session-1" }), 0),
    false,
  );
});
