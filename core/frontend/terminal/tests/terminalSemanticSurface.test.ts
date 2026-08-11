/**
 * The surface a view session drives when nothing on the client interprets.
 *
 * Every port is injected, so what is proved here is what the session depends
 * on: where a geometry comes from, what is refused when the font cannot be
 * measured, and which of the byte path's operations mean nothing now. The
 * frames are the host's own, through the decoder and the client model.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { TerminalCellMetrics, TerminalPaintPlan } from "../terminalCellPaint.ts";
import { TerminalCellPresenter } from "../terminalCellPresenter.ts";
import type { TerminalSurfacePalette } from "../terminalCellSurface.ts";
import { TerminalClientModel, type TerminalScreenFrame } from "../terminalClientModel.ts";
import { decodeTerminalEvent } from "../terminalEventDecoder.ts";
import { createSemanticTerminalSurface } from "../terminalSemanticSurface.ts";
import type { TerminalInput } from "../terminalSemanticInput.ts";
import { TerminalViewportPin } from "../terminalViewportPin.ts";
import type { TerminalAttachmentId } from "../types.ts";

const CELL: TerminalCellMetrics = { cellWidth: 9, cellHeight: 18 };

const PALETTE: TerminalSurfacePalette = {
  foreground: "chrome-fg",
  background: "chrome-bg",
  cursor: "chrome-cursor",
  selection: "chrome-selection",
};

const fixture = JSON.parse(
  readFileSync(new URL("../terminalScreenFixture.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

function hostFrame(sequence: number): TerminalScreenFrame {
  const event = decodeTerminalEvent(structuredClone(fixture));
  if (event.event !== "screen") throw new Error("the fixture is a screen frame");
  return { sequence, revision: event.revision, state: event.state };
}

function harness() {
  const model = new TerminalClientModel();
  const frames: number[][] = [];
  const scheduled: (() => void)[] = [];
  const log: string[] = [];

  const state = {
    cell: CELL as TerminalCellMetrics | null,
    box: { width: 900, height: 360 } as { width: number; height: number } | null,
    attachment: null as TerminalAttachmentId | null,
    inputs: [] as TerminalInput[],
  };

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
    metrics: () => state.cell,
    palette: () => PALETTE,
    schedule: (paint) => {
      scheduled.push(paint);
      return () => {
        const index = scheduled.indexOf(paint);
        if (index >= 0) scheduled.splice(index, 1);
      };
    },
    onFrame: (plan: TerminalPaintPlan) => frames.push([...plan.paintedRows]),
  });

  const surface = createSemanticTerminalSurface({
    model,
    presenter,
    pin: new TerminalViewportPin({
      bottomOffset: () => 0,
      baseY: () => 0,
      scrollToBottom: () => log.push("scroll-bottom"),
      scrollToLine: () => log.push("scroll-line"),
    }),
    mount: () => log.push("mount"),
    focus: () => log.push("focus"),
    measureContainer: () => state.box,
    measureCell: () => state.cell,
    applyTheme: () => log.push("theme"),
    applySettings: () => log.push("settings"),
    publishAttachmentId: (id) => {
      state.attachment = id;
    },
    logActiveFont: () => log.push("font"),
  });

  return {
    model,
    surface,
    presenter,
    frames,
    log,
    state,
    tick() {
      const due = [...scheduled];
      scheduled.length = 0;
      for (const task of due) task();
    },
  };
}

test("opening mounts the presentation and starts watching the model", () => {
  const h = harness();
  h.surface.open();
  h.surface.open();

  assert.deepEqual(h.log, ["mount", "mount"], "mounting twice is the binding's to make idempotent");

  h.model.applyScreen(hostFrame(10));
  h.tick();
  assert.equal(h.frames.length, 1, "one presenter, started once, whatever open() was called");
});

test("the geometry is the host's, and there is none before the first frame", () => {
  const h = harness();
  h.surface.open();

  assert.deepEqual(
    h.surface.geometry(),
    { columns: 0, rows: 0 },
    "a client that answered a size here would be answering for the host",
  );

  h.model.applyScreen(hostFrame(10));
  const screen = h.model.state?.screen;
  assert.ok(screen);
  assert.deepEqual(h.surface.geometry(), { columns: screen.columns, rows: screen.rows });
});

test("a resize changes nothing locally: the host's next frame is the resize", () => {
  const h = harness();
  h.surface.open();
  h.model.applyScreen(hostFrame(10));
  h.tick();
  const before = h.surface.geometry();
  h.frames.length = 0;

  h.surface.resize({ columns: 40, rows: 10 });
  h.surface.resizePreservingViewport({ columns: 40, rows: 10 });
  h.surface.reset();
  h.tick();

  assert.deepEqual(h.surface.geometry(), before, "no second copy of the screen's size");
  assert.deepEqual(h.frames, [], "and nothing was redrawn for a change that did not happen");
});

test("nothing is deferred on the length of a buffer this surface does not hold", () => {
  const h = harness();
  assert.equal(h.surface.bufferRows(), 0, "the host reflows; this client never does");
});

test("a proposal is whole cells for the box, with no floor of its own", () => {
  const h = harness();

  assert.deepEqual(
    h.surface.proposeGeometry(),
    { columns: 100, rows: 20 },
    "900 / 9 and 360 / 18",
  );

  h.state.box = { width: 4, height: 4 };
  assert.deepEqual(
    h.surface.proposeGeometry(),
    { columns: 0, rows: 0 },
    "the floor every size is held to belongs to the session, which applies it once",
  );
});

test("an unmeasurable box or font proposes nothing rather than a guess", () => {
  const h = harness();

  h.state.box = null;
  assert.equal(h.surface.proposeGeometry(), null, "a hidden container");

  h.state.box = { width: 0, height: 360 };
  assert.equal(h.surface.proposeGeometry(), null, "a container with no area");

  h.state.box = { width: 900, height: 360 };
  h.state.cell = null;
  assert.equal(h.surface.proposeGeometry(), null, "a font that has not loaded");
});

test("theme, settings, refresh and a reveal each owe a full frame", () => {
  for (const act of [
    (surface: ReturnType<typeof harness>["surface"]) => surface.applyCurrentTheme(),
    (surface: ReturnType<typeof harness>["surface"]) => surface.applyCurrentSettings(),
    (surface: ReturnType<typeof harness>["surface"]) => surface.refresh(),
    (surface: ReturnType<typeof harness>["surface"]) => surface.resyncViewport(),
  ]) {
    const h = harness();
    h.surface.open();
    h.model.applyScreen(hostFrame(10));
    h.tick();
    h.frames.length = 0;

    act(h.surface);
    h.tick();
    assert.deepEqual(
      h.frames,
      [[0, 1, 2, 3, 4, 5, 6, 7]],
      "the pixels are no longer the last frame's, so the frame is everything",
    );
  }
});

test("local input names what a person did, and no byte sink is ever called", () => {
  const h = harness();
  const bytes: string[] = [];
  const inputs: TerminalInput[] = [];
  h.surface.open();
  h.surface.setInputSink((data) => bytes.push(data));
  h.surface.setSemanticInputSink((input) => inputs.push(input));

  h.surface.reportInput({ kind: "focus", gained: true });

  assert.deepEqual(inputs, [{ kind: "focus", gained: true }]);
  assert.deepEqual(bytes, [], "bytes chosen by a client are the copy of the modes this path ends");
});

test("input observed between sessions is dropped, not queued", () => {
  const h = harness();
  const inputs: TerminalInput[] = [];
  h.surface.setSemanticInputSink((input) => inputs.push(input));
  h.surface.setSemanticInputSink(null);

  h.surface.reportInput({ kind: "focus", gained: true });
  assert.deepEqual(inputs, [], "there is nowhere to send it, exactly as with a closed input path");
});

test("the surface reports how it drew the terminal, and nothing before it drew", () => {
  const h = harness();
  h.surface.open();

  assert.equal(
    h.surface.surfaceGeometry(),
    null,
    "a pointer report needs a screen, and there is none yet",
  );

  h.model.applyScreen(hostFrame(10));
  const screen = h.model.state?.screen;
  assert.ok(screen);
  assert.deepEqual(h.surface.surfaceGeometry(), {
    screenWidth: screen.columns * CELL.cellWidth,
    screenHeight: screen.rows * CELL.cellHeight,
    cellWidth: CELL.cellWidth,
    cellHeight: CELL.cellHeight,
    paddingTop: 0,
    paddingBottom: 0,
    paddingLeft: 0,
    paddingRight: 0,
  });

  h.state.cell = null;
  assert.equal(h.surface.surfaceGeometry(), null, "and none while the font cannot be measured");
});

test("the attachment id is published for the terminal's other readers", () => {
  const h = harness();
  const id = "attachment-1" as unknown as TerminalAttachmentId;

  h.surface.publishAttachmentId(id);
  assert.equal(h.state.attachment, id);
  h.surface.publishAttachmentId(null);
  assert.equal(h.state.attachment, null);
});
