import assert from "node:assert/strict";
import { test } from "node:test";

import {
  reviewTerminalPaste,
  type TerminalPasteReviewPorts,
} from "../terminalPasteReview.ts";

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
