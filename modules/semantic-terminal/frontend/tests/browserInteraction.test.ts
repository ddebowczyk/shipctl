import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createTerminalImeLifecycle,
  placeTerminalIme,
  reportTerminalEffectOutcome,
  reviewTerminalPaste,
  type TerminalImeState,
  type TerminalPasteReviewPorts,
} from "../src/browserInteraction.ts";

test("semantic bell and clipboard effects report one browser outcome", () => {
  let bells = 0;
  let clipboardRefusals = 0;
  const ports = {
    bell: () => { bells += 1; },
    clipboardRefused: () => { clipboardRefusals += 1; },
  };

  reportTerminalEffectOutcome({ kind: "bell" }, ports);
  reportTerminalEffectOutcome({ kind: "clipboard" }, ports);
  reportTerminalEffectOutcome({ kind: "title" }, ports);

  assert.equal(bells, 1);
  assert.equal(clipboardRefusals, 1);
});

test("pre-edit stays in presentation and commit is sent once", () => {
  const states: TerminalImeState[] = [];
  const committed: string[] = [];
  const ime = createTerminalImeLifecycle({
    present: (state) => states.push(state),
    commit: (text) => committed.push(text),
  });

  ime.start();
  ime.update("に");
  ime.update("日本");
  assert.deepEqual(committed, []);
  assert.equal(ime.ownsKey(false), true);

  ime.finish("日本");
  ime.finish("日本");
  assert.deepEqual(committed, ["日本"]);
  assert.deepEqual(states.at(-1), { active: false, preedit: "" });
});

test("cancellation clears pre-edit and sends nothing", () => {
  const states: TerminalImeState[] = [];
  const committed: string[] = [];
  const ime = createTerminalImeLifecycle({
    present: (state) => states.push(state),
    commit: (text) => committed.push(text),
  });

  ime.start();
  ime.update("候補");
  ime.finish("");

  assert.deepEqual(committed, []);
  assert.deepEqual(states.at(-1), { active: false, preedit: "" });
  assert.equal(ime.ownsKey(false), false);
  assert.equal(ime.ownsKey(true), true);
});

test("editing host placement follows the painted cursor and cell metrics", () => {
  assert.deepEqual(
    placeTerminalIme({
      width: 900,
      cellWidth: 9,
      cellHeight: 18,
      cursor: { x: 72, y: 36 },
    }),
    { left: 72, top: 36, width: 828, height: 18 },
  );
  assert.equal(
    placeTerminalIme({ width: 900, cellWidth: 9, cellHeight: 18, cursor: null }),
    null,
  );
});

function harness(enabled: boolean, safe: boolean) {
  let classifyCalls = 0;
  let submissions = 0;
  let confirmation: (() => void) | null = null;
  let cancellation: (() => void) | null = null;
  let failure: unknown = null;
  const ports: TerminalPasteReviewPorts = {
    confirmationEnabled: () => enabled,
    classify: async () => {
      classifyCalls += 1;
      return safe;
    },
    requestConfirmation: (accept, cancel) => {
      confirmation = accept;
      cancellation = cancel;
    },
    reportFailure: (error) => {
      failure = error;
    },
  };
  reviewTerminalPaste(ports, "echo one\necho two", () => {
    submissions += 1;
  });
  return {
    settle: () => new Promise<void>((resolve) => setImmediate(resolve)),
    classifyCalls: () => classifyCalls,
    submissions: () => submissions,
    confirmation: () => confirmation,
    cancellation: () => cancellation,
    failure: () => failure,
  };
}

test("disabled confirmation submits directly without calling the host", () => {
  const run = harness(false, false);
  assert.equal(run.classifyCalls(), 0);
  assert.equal(run.submissions(), 1);
  assert.equal(run.confirmation(), null);
});

test("an enabled safe paste submits after host classification", async () => {
  const run = harness(true, true);
  assert.equal(run.submissions(), 0);
  await run.settle();
  assert.equal(run.classifyCalls(), 1);
  assert.equal(run.submissions(), 1);
  assert.equal(run.confirmation(), null);
});

test("an enabled unsafe paste waits for explicit acceptance", async () => {
  const run = harness(true, false);
  await run.settle();
  assert.equal(run.submissions(), 0);
  assert.ok(run.confirmation());
  run.confirmation()?.();
  assert.equal(run.submissions(), 1);
});

test("cancelling an unsafe paste sends no input", async () => {
  const run = harness(true, false);
  await run.settle();
  assert.ok(run.cancellation());
  run.cancellation()?.();
  assert.equal(run.submissions(), 0);
});

test("a classification failure does not submit the paste", async () => {
  const expected = new Error("classification failed");
  let submissions = 0;
  let observed: unknown = null;
  reviewTerminalPaste(
    {
      confirmationEnabled: () => true,
      classify: async () => {
        throw expected;
      },
      requestConfirmation: () => assert.fail("confirmation must not open"),
      reportFailure: (error) => {
        observed = error;
      },
    },
    "unsafe",
    () => {
      submissions += 1;
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(submissions, 0);
  assert.equal(observed, expected);
});
