import assert from "node:assert/strict";
import { test } from "node:test";

import { keyScrollPinIntent, wheelScrollPinIntent } from "../terminalScrollPin.ts";

test("scrolling up leaves follow mode", () => {
  assert.equal(wheelScrollPinIntent(-1), "unpin");
  assert.equal(wheelScrollPinIntent(-120), "unpin");
});

test("scrolling down defers to the resulting buffer position", () => {
  assert.equal(wheelScrollPinIntent(1), "resync");
  assert.equal(wheelScrollPinIntent(120), "resync");
  // A horizontal-only wheel event must not be read as scrolling up.
  assert.equal(wheelScrollPinIntent(0), "resync");
});

test("shifted backward viewport keys leave follow mode", () => {
  for (const key of ["PageUp", "Home", "ArrowUp"]) {
    assert.equal(keyScrollPinIntent({ shiftKey: true, key }), "unpin", key);
  }
});

test("shifted forward viewport keys defer to the resulting position", () => {
  for (const key of ["PageDown", "End", "ArrowDown"]) {
    assert.equal(keyScrollPinIntent({ shiftKey: true, key }), "resync", key);
  }
});

test("terminal input resumes follow mode", () => {
  for (const key of ["a", "Enter", "Backspace", "Escape", "Tab"]) {
    assert.equal(keyScrollPinIntent({ shiftKey: false, key }), "follow", key);
  }
  // Shift is what distinguishes a viewport gesture from input: unshifted
  // arrows are cursor movement the shell consumes.
  for (const key of ["ArrowUp", "PageUp", "Home"]) {
    assert.equal(keyScrollPinIntent({ shiftKey: false, key }), "follow", key);
  }
  // A shifted non-viewport key is still input.
  assert.equal(keyScrollPinIntent({ shiftKey: true, key: "A" }), "follow");
});
