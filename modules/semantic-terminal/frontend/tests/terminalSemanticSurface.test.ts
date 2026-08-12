import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TerminalCellPresenter,
  TerminalClientModel,
  TerminalViewportPin,
  createSemanticTerminalSurface,
  type TerminalInput,
} from "../src/index.ts";

function surfaceHarness() {
  const model = new TerminalClientModel();
  const inputs: TerminalInput[] = [];
  let attachmentId: string | null = null;
  const presenter = new TerminalCellPresenter({
    model,
    target: {
      beginFrame: () => {},
      clear: () => {},
      fill: () => {},
      drawRun: () => {},
      underline: () => {},
      cursor: () => {},
      endFrame: () => {},
    },
    metrics: () => ({ cellWidth: 9, cellHeight: 18 }),
    palette: () => ({
      foreground: "foreground",
      background: "background",
      cursor: "cursor",
      selection: "selection",
    }),
    schedule: () => () => {},
  });
  const surface = createSemanticTerminalSurface({
    model,
    presenter,
    pin: new TerminalViewportPin({
      bottomOffset: () => 0,
      baseY: () => 0,
      scrollToBottom: () => {},
      scrollToLine: () => {},
    }),
    mount: () => {},
    focus: () => {},
    measureContainer: () => ({ width: 900, height: 360 }),
    measureCell: () => ({ cellWidth: 9, cellHeight: 18 }),
    applyTheme: () => {},
    applySettings: () => {},
    publishAttachmentId: (id) => {
      attachmentId = id;
    },
    logActiveFont: () => {},
  });
  return { attachmentId: () => attachmentId, inputs, surface };
}

test("semantic surface stays a presentation, not a second terminal authority", () => {
  const h = surfaceHarness();
  const bytes: string[] = [];

  assert.deepEqual(h.surface.geometry(), { columns: 0, rows: 0 });
  assert.deepEqual(h.surface.proposeGeometry(), { columns: 100, rows: 20 });

  h.surface.setInputSink((value) => bytes.push(value));
  h.surface.setSemanticInputSink((input) => h.inputs.push(input));
  h.surface.reportInput({ kind: "focus", gained: true });
  h.surface.publishAttachmentId("attachment-1");

  assert.deepEqual(bytes, []);
  assert.deepEqual(h.inputs, [{ kind: "focus", gained: true }]);
  assert.equal(h.attachmentId(), "attachment-1");
});
