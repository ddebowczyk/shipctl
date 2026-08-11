/**
 * What a surface is told to draw, recorded.
 *
 * The target is a fake that writes down its calls, which is the whole of what a
 * Canvas or WebGL painter would receive. Everything a reader could disagree
 * with — order, colour resolution, reverse video, what a selection looks like,
 * what a partial frame leaves alone — is decided here and asserted here, with
 * no browser and no DOM emulator.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { decodeScreenState, type TerminalScreenModel } from "../terminalClientModel.ts";
import { planTerminalPaint, type TerminalCellMetrics } from "../terminalCellPaint.ts";
import {
  paintTerminalFrame,
  type TerminalPaintTarget,
  type TerminalSurfacePalette,
} from "../terminalCellSurface.ts";

const METRICS: TerminalCellMetrics = { cellWidth: 9, cellHeight: 18 };

const PALETTE: TerminalSurfacePalette = {
  foreground: "chrome-fg",
  background: "chrome-bg",
  cursor: "chrome-cursor",
  selection: "chrome-selection",
};

const fixture = JSON.parse(
  readFileSync(new URL("../terminalScreenFixture.json", import.meta.url), "utf8"),
) as { state: unknown };

function hostScreen(change?: (state: Record<string, any>) => void): TerminalScreenModel {
  const state = structuredClone(fixture.state) as Record<string, any>;
  change?.(state);
  return decodeScreenState(state);
}

interface Recorded {
  readonly kind: string;
  readonly detail: Record<string, unknown>;
}

function recordingTarget() {
  const calls: Recorded[] = [];
  const target: TerminalPaintTarget = {
    beginFrame: (size) => calls.push({ kind: "beginFrame", detail: { ...size } }),
    clear: (rect) => calls.push({ kind: "clear", detail: { ...rect } }),
    fill: (rect, color) => calls.push({ kind: "fill", detail: { ...rect, color } }),
    drawRun: (run) => calls.push({ kind: "drawRun", detail: { ...run } }),
    underline: (rect, color) => calls.push({ kind: "underline", detail: { ...rect, color } }),
    cursor: (rect, shape, color) =>
      calls.push({ kind: "cursor", detail: { ...rect, shape, color } }),
    endFrame: () => calls.push({ kind: "endFrame", detail: {} }),
  };
  return { target, calls, kinds: () => [...new Set(calls.map((call) => call.kind))] };
}

function paint(
  screen: TerminalScreenModel,
  repaint: "damage" | "full" = "full",
  palette: TerminalSurfacePalette = PALETTE,
) {
  const recorder = recordingTarget();
  const plan = planTerminalPaint(screen, { metrics: METRICS, repaint });
  paintTerminalFrame(recorder.target, plan, palette);
  return { ...recorder, plan };
}

test("a frame is drawn back to front, once, between begin and end", () => {
  const { calls } = paint(hostScreen());

  assert.equal(calls.at(0)?.kind, "beginFrame");
  assert.deepEqual(calls.at(0)?.detail, { width: 40 * 9, height: 8 * 18 });
  assert.equal(calls.at(-1)?.kind, "endFrame");

  const order = calls.map((call) => call.kind);
  const lastBackground = order.lastIndexOf("fill");
  const firstGlyph = order.indexOf("drawRun");
  assert.ok(firstGlyph > order.indexOf("clear"), "the row is cleared before anything lands on it");
  assert.ok(
    order.lastIndexOf("underline") > lastBackground,
    "link decoration goes over the glyphs, not under the backgrounds",
  );
});

test("glyphs are drawn with the host's spans and the host's colours", () => {
  const { calls } = paint(hostScreen());
  const runs = calls.filter((call) => call.kind === "drawRun").map((call) => call.detail);

  const bold = runs.find((run) => run.text === "bold");
  assert.deepEqual(bold, {
    x: 2 * 9,
    y: 0,
    width: 4 * 9,
    height: 18,
    glyphs: ["b", "o", "l", "d"],
    text: "bold",
    advance: 9,
    bold: true,
    color: "rgb(10, 20, 30)",
    hyperlink: null,
  });

  const wide = runs.find((run) => run.advance === 2 * 9);
  assert.equal(wide?.width, 2 * 9, "one wide grapheme, drawn across the host's two columns");
  assert.equal(wide?.glyphs.length, 1, "two columns, one cell, one glyph to place");
  assert.equal(wide?.color, "rgb(230, 230, 230)", "the child named no colour, so the host's default");

  const link = runs.find((run) => run.hyperlink !== null);
  assert.equal(link?.text, "link");
  const underlines = calls.filter((call) => call.kind === "underline");
  assert.equal(underlines.length, 1, "one decoration for the one link the host reported");
  assert.equal(underlines[0].detail.width, 4 * 9);
});

test("a run of blanks costs a background and no glyph", () => {
  const { calls } = paint(hostScreen());
  assert.equal(
    calls.some((call) => call.kind === "drawRun" && String(call.detail.text).trim() === ""),
    false,
  );
});

test("the chrome supplies only what the child left unsaid", () => {
  const bare = hostScreen((state) => {
    state.colors.foreground = null;
    state.colors.background = null;
  });
  const { calls } = paint(bare);

  const rowFills = calls.filter((call) => call.kind === "fill" && call.detail.width === 40 * 9);
  assert.equal(rowFills[0].detail.color, "chrome-bg");
  const runs = calls.filter((call) => call.kind === "drawRun");
  const plain = runs.find((run) => run.detail.text === "link");
  assert.equal(plain?.detail.color, "chrome-fg");

  // A colour the child did name is never replaced by the chrome's.
  const bold = runs.find((run) => run.detail.text === "bold");
  assert.equal(bold?.detail.color, "rgb(10, 20, 30)");
});

test("reverse video swaps the two defaults and changes no cell", () => {
  const { calls } = paint(hostScreen((state) => {
    state.modes.reverseVideo = true;
  }));

  const rowFill = calls.find((call) => call.kind === "fill" && call.detail.width === 40 * 9);
  assert.equal(rowFill?.detail.color, "rgb(230, 230, 230)", "the default foreground is the ground");
  const link = calls.find((call) => call.kind === "drawRun" && call.detail.text === "link");
  assert.equal(link?.detail.color, "rgb(16, 16, 16)");
  const bold = calls.find((call) => call.kind === "drawRun" && call.detail.text === "bold");
  assert.equal(bold?.detail.color, "rgb(10, 20, 30)", "a cell the child coloured is untouched");
});

test("a selected cell takes the chrome's selection colour", () => {
  const { calls } = paint(hostScreen((state) => {
    state.selection = [{ row: 2, spans: [{ start: 0, end: 4 }] }];
  }));

  const selection = calls.filter(
    (call) => call.kind === "fill" && call.detail.color === "chrome-selection",
  );
  assert.equal(selection.length, 1);
  assert.deepEqual(selection[0].detail, {
    x: 0,
    y: 2 * 18,
    width: 4 * 9,
    height: 18,
    color: "chrome-selection",
  });
});

test("the cursor is drawn under the glyphs, and only where the frame paints", () => {
  const { calls } = paint(hostScreen());
  const order = calls.map((call) => call.kind);
  const cursor = calls.findIndex((call) => call.kind === "cursor");
  assert.ok(cursor > 0);
  assert.ok(cursor < order.indexOf("drawRun"), "the glyph it sits on stays readable");
  // The whole cell, and the host's own shape: how much of that rectangle a
  // bar or an underline covers is the target's, because only it knows how thin
  // a line the display can draw.
  assert.deepEqual(calls[cursor].detail, {
    x: 5 * 9,
    y: 4 * 18,
    width: 9,
    height: 18,
    shape: "block",
    color: "chrome-cursor",
  });

  const hidden = paint(hostScreen((state) => {
    state.cursor.visible = false;
  }));
  assert.equal(hidden.calls.some((call) => call.kind === "cursor"), false);

  // A partial frame that does not include the cursor's row leaves the pixels
  // that already hold it alone rather than drawing a second one.
  const elsewhere = paint(
    hostScreen((state) => {
      state.damage = { scope: "partial", rows: [0] };
    }),
    "damage",
  );
  assert.deepEqual(elsewhere.plan.paintedRows, [0]);
  assert.equal(elsewhere.calls.some((call) => call.kind === "cursor"), false);
});

test("a partial frame touches only the rows the host named", () => {
  const { calls } = paint(
    hostScreen((state) => {
      state.damage = { scope: "partial", rows: [2] };
    }),
    "damage",
  );

  const touched = new Set(
    calls
      .filter((call) => call.kind !== "beginFrame" && call.kind !== "endFrame")
      .map((call) => Number(call.detail.y) / 18),
  );
  assert.deepEqual([...touched], [2]);
});
