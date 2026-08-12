import assert from "node:assert/strict";
import { test } from "node:test";

import {
  noticeDiagnosticLogEntry,
  terminalDiagnosticLogEntry,
  useNoticeStore,
} from "@shipctl/core/shared";

test("terminal diagnostics contain state only and no input payload", () => {
  const diagnostic = {
    occurredAt: "2026-08-12T08:00:00.000Z",
    terminalId: "terminal-1",
    event: "input_result",
    facts: { status: "unavailable", reason: "not_ready" },
  } as const;

  assert.deepEqual(JSON.parse(terminalDiagnosticLogEntry(diagnostic)), {
    kind: "terminal",
    ...diagnostic,
  });
});

test("error notices persist as grouped, payload-free runtime diagnostics", () => {
  const store = useNoticeStore.getState();
  store.clearNoticeHistory();

  store.pushNotice({
    tone: "error",
    title: "Couldn’t attach terminal",
    message: "state.selection is not an array",
  }, { durationMs: 0 });
  store.pushNotice({
    tone: "error",
    title: "Couldn’t attach terminal",
    message: "state.selection is not an array",
  }, { durationMs: 0 });

  const [diagnostic] = useNoticeStore.getState().noticeHistory;
  assert.equal(useNoticeStore.getState().noticeHistory.length, 1);
  assert.equal(diagnostic.occurrences, 2);
  assert.equal(diagnostic.title, "Couldn’t attach terminal");
  assert.deepEqual(JSON.parse(noticeDiagnosticLogEntry(diagnostic)), {
    kind: "notice",
    ...diagnostic,
  });
});
