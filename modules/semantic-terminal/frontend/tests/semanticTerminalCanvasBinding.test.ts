import assert from "node:assert/strict";
import { test } from "node:test";

import {
  copyToTerminalClipboard,
  focusSemanticTerminalFromPointer,
  pasteFromTerminalClipboard,
  terminalClipboardShortcut,
  type TerminalClipboardPorts,
} from "@shipctl/module-semantic-terminal";

test("a canvas press cancels its default action before focusing terminal input", () => {
  const trace: string[] = [];

  focusSemanticTerminalFromPointer({
    type: "pointerdown",
    button: 0,
    preventDefault: () => trace.push("prevent-default"),
  }, () => trace.push("focus-keyboard"));

  assert.deepEqual(trace, ["prevent-default", "focus-keyboard"]);
});

test("other pointer events do not change keyboard focus", () => {
  const trace: string[] = [];

  focusSemanticTerminalFromPointer({
    type: "pointermove",
    button: -1,
    preventDefault: () => trace.push("prevent-default"),
  }, () => trace.push("focus-keyboard"));

  assert.deepEqual(trace, []);
});

test("a secondary canvas press leaves focus for the terminal context menu", () => {
  const trace: string[] = [];

  focusSemanticTerminalFromPointer({
    type: "pointerdown",
    button: 2,
    preventDefault: () => trace.push("prevent-default"),
  }, () => trace.push("focus-keyboard"));

  assert.deepEqual(trace, []);
});

test("Command-C and Command-V stay browser clipboard gestures", () => {
  assert.equal(terminalClipboardShortcut({
    code: "KeyC", metaKey: true, ctrlKey: false, altKey: false,
  }), "copy");
  assert.equal(terminalClipboardShortcut({
    code: "KeyV", metaKey: true, ctrlKey: false, altKey: false,
  }), "paste");
  assert.equal(terminalClipboardShortcut({
    code: "KeyC", metaKey: false, ctrlKey: true, altKey: false,
  }), null, "plain Control-C must still reach the child");
});

test("context-menu clipboard actions copy and paste once", async () => {
  const copied: string[] = [];
  const pasted: string[] = [];
  const reviewed: string[] = [];
  const unavailable: string[] = [];
  const ports: TerminalClipboardPorts = {
    readText: async () => "echo ready",
    writeText: async (text) => { copied.push(text); },
    reviewPaste: (text, submit) => { reviewed.push(text); submit(); },
    submitPaste: (text) => { pasted.push(text); },
    unavailable: (action) => { unavailable.push(action); },
  };

  await copyToTerminalClipboard("selected", ports);
  await pasteFromTerminalClipboard(ports);

  assert.deepEqual(copied, ["selected"]);
  assert.deepEqual(reviewed, ["echo ready"]);
  assert.deepEqual(pasted, ["echo ready"]);
  assert.deepEqual(unavailable, []);
});

test("clipboard failures use the observable failure port", async () => {
  const failures: string[] = [];
  const ports: TerminalClipboardPorts = {
    readText: async () => { throw new Error("read denied"); },
    writeText: async () => { throw new Error("write denied"); },
    reviewPaste: () => {},
    submitPaste: () => {},
    unavailable: (action, error) => {
      failures.push(`${action}:${error instanceof Error ? error.message : String(error)}`);
    },
  };

  await copyToTerminalClipboard("selected", ports);
  await pasteFromTerminalClipboard(ports);

  assert.deepEqual(failures, ["copy:write denied", "paste:read denied"]);
});
