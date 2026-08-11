/**
 * What scrolled away, on the client side.
 *
 * The window every trace decodes is `terminalHistoryFixture.json`, written by
 * the host's own parser in `core/backend/src/terminal/contract.rs`. That is what
 * makes these assertions about the host's shape rather than about a reading of
 * it: a renamed field, a dropped cell fact, or a history row that stopped being
 * the same kind of row as a viewport row fails here.
 *
 * The rule the client must not break is that a history row number is a
 * position, never an identity. Eviction renumbers history silently, so the
 * model holds one window — the one it read — and no trace here joins two.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  TerminalClientModel,
  decodeHistoryWindow,
  type TerminalHistoryWindowModel,
} from "../terminalClientModel.ts";
import { TerminalAttachmentController } from "../terminalAttachmentController.ts";
import type { TerminalAttachmentPorts } from "../terminalAttachmentController.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../terminalHistoryFixture.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

function hostWindow(): Record<string, unknown> {
  return structuredClone(fixture);
}

function text(window: TerminalHistoryWindowModel, row: number): string {
  return window.rows[row].cells.map((cell) => cell.text).join("");
}

test("the host's own history window decodes whole", () => {
  const window = decodeHistoryWindow(hostWindow());

  assert.equal(window.startRow, 0, "row zero is the oldest row still retained");
  assert.ok(window.rows.length > 0);
  assert.ok(
    window.historyRows >= window.startRow + window.rows.length,
    "a window cannot reach past the history it was read from",
  );
});

test("a history row carries every fact a viewport row carries", () => {
  const window = decodeHistoryWindow(hostWindow());
  const cells = window.rows.flatMap((row) => row.cells);

  // Each of these is a fact a client cannot recompute from text, which is the
  // whole reason history is read from the host instead of reconstructed.
  assert.ok(
    cells.some((cell) => cell.width === "wide"),
    "the wide grapheme lost its width on the way into history",
  );
  assert.ok(
    cells.some((cell) => cell.hyperlink !== null),
    "the hyperlink did not survive scrolling",
  );
  assert.ok(
    cells.some((cell) => cell.bold),
    "the styled run did not survive scrolling",
  );
  assert.ok(
    cells.some((cell) => cell.foreground !== null),
    "the run's colour did not survive scrolling",
  );
  assert.ok(
    window.rows.some((row) => row.prompt === "prompt"),
    "the prompt mark did not survive scrolling",
  );
  // Where a line wraps is the host's decision, and it is still the host's after
  // the line scrolls off: the wrapped row and its continuation are both here.
  assert.ok(
    window.rows.some((row) => row.wrapped),
    "the wrapped row lost its wrap",
  );
  assert.ok(
    window.rows.some((row) => row.continuation),
    "the continuation row lost its continuation",
  );
});

test("a window that reaches past the history it was read from is refused", () => {
  const window = hostWindow();
  window.historyRows = 1;

  assert.throws(
    () => decodeHistoryWindow(window),
    /reaches row/,
    "believing this window would mean holding rows the host does not",
  );
});

test("a window missing a row fact is refused rather than filled in", () => {
  const missingWidth = hostWindow() as any;
  delete missingWidth.rows[0].cells[0].width;
  assert.throws(() => decodeHistoryWindow(missingWidth), /width/);

  const missingPrompt = hostWindow() as any;
  delete missingPrompt.rows[0].prompt;
  assert.throws(() => decodeHistoryWindow(missingPrompt), /prompt/);

  const missingStart = hostWindow() as any;
  delete missingStart.startRow;
  assert.throws(() => decodeHistoryWindow(missingStart), /startRow/);
});

test("the model holds the window it read, and a refused one leaves it alone", () => {
  const model = new TerminalClientModel();
  assert.equal(model.history, null, "nothing is held before a read");

  assert.deepEqual(model.applyHistory(hostWindow()), { status: "committed" });
  const held = model.history;
  assert.ok(held);
  assert.equal(held.startRow, 0);

  const broken = hostWindow() as any;
  broken.rows[0].cells[0].width = "enormous";
  const outcome = model.applyHistory(broken);
  assert.equal(outcome.status, "rejected");
  assert.equal(model.history, held, "the window it had is the window it keeps");
});

test("a later window replaces the earlier one instead of joining it", () => {
  const model = new TerminalClientModel();
  model.applyHistory(hostWindow());

  // The same host, read again further back. Row numbers from two reads cannot
  // be joined: eviction renumbers history, and `historyRows` stands still once
  // retention is at its limit, so two windows that look adjacent may not be.
  const later = hostWindow() as any;
  later.startRow = 2;
  later.rows = later.rows.slice(0, 2);
  model.applyHistory(later);

  assert.equal(model.history?.startRow, 2);
  assert.equal(model.history?.rows.length, 2, "one window is held, not an accumulation");
});

test("history survives what a surface does, and ends only when the model does", () => {
  const model = new TerminalClientModel();
  model.applyHistory(hostWindow());
  const before = model.history;

  // Subscribing and unsubscribing is a surface arriving and leaving.
  model.subscribe(() => {})();
  assert.equal(model.history, before, "a surface leaving does not take history with it");

  model.dispose();
  assert.equal(model.history, null);
  assert.equal(model.applyHistory(hostWindow()).status, "rejected");
});

/** The smallest controller that can read history: no attachment is opened. */
function controller(overrides: Partial<TerminalAttachmentPorts> = {}): {
  readonly controller: TerminalAttachmentController;
  readonly model: TerminalClientModel;
  readonly reads: { startRow: number; rows: number }[];
} {
  const model = new TerminalClientModel();
  const reads: { startRow: number; rows: number }[] = [];
  const ports: TerminalAttachmentPorts = {
    attach: () => Promise.reject(new Error("no trace here opens an attachment")),
    detach: () => Promise.resolve(),
    observeDescriptor: () => {},
    installReplay: () => {},
    stopOutput: () => {},
    releaseOutput: () => {},
    acceptsInput: () => false,
    write: () => Promise.resolve({ status: "accepted" }),
    publishAttachmentId: () => {},
    reportError: () => {},
    model,
    readHistory: (startRow, rows) => {
      reads.push({ startRow, rows });
      return Promise.resolve(hostWindow());
    },
    ...overrides,
  };
  return { controller: new TerminalAttachmentController(ports), model, reads };
}

test("a read reaches the host and commits through the model's decoder", async () => {
  const { controller: attachment, model, reads } = controller();

  const outcome = await attachment.readHistory(0, 6);

  assert.deepEqual(outcome, { status: "committed" });
  assert.deepEqual(reads, [{ startRow: 0, rows: 6 }]);
  assert.equal(text(model.history!, 0).trimEnd(), "$ bold");
});

test("history is readable while no baseline is current", async () => {
  // `acceptsInput` is false throughout: no attachment is held at all. Input
  // would be refused here, and a read must not be — a person recovering, or
  // looking at a terminal whose child exited, still wants to see what
  // scrolled away.
  const { controller: attachment, model } = controller();
  assert.equal(attachment.acceptsInput(), false);

  assert.equal((await attachment.readHistory(0, 6)).status, "committed");
  assert.ok(model.history);
});

test("a client with no history transport is refused, not given a reconstruction", async () => {
  const { controller: attachment, model } = controller({ readHistory: undefined });

  const outcome = await attachment.readHistory(0, 6);

  assert.equal(outcome.status, "rejected");
  assert.match(
    outcome.status === "rejected" ? outcome.detail : "",
    /no history transport/,
    "the byte path has none, and guessing from replay is the dependency this ends",
  );
  assert.equal(model.history, null);
});

test("a host that fails a read leaves the model as it was", async () => {
  const { controller: attachment, model } = controller({
    readHistory: () => Promise.reject(new Error("the socket went away")),
  });

  const outcome = await attachment.readHistory(0, 6);

  assert.equal(outcome.status, "rejected");
  assert.match(outcome.status === "rejected" ? outcome.detail : "", /socket went away/);
  assert.equal(model.history, null);
});

test("a host that answers a shape it does not write is refused", async () => {
  const { controller: attachment, model } = controller({
    readHistory: () => Promise.resolve({ startRow: 0, historyRows: 4, rows: [{}] }),
  });

  assert.equal((await attachment.readHistory(0, 1)).status, "rejected");
  assert.equal(model.history, null, "a refused window is not half-applied");
});
