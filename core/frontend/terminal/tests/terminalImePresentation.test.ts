import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createTerminalImeLifecycle,
  placeTerminalIme,
  type TerminalImeState,
} from "../terminalImePresentation.ts";

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
