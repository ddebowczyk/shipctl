import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";

import xterm from "@xterm/xterm";

const { Terminal } = xterm;

function fromHex(value) {
  return Buffer.from(value, "hex");
}

function write(terminal, bytes) {
  return new Promise((resolve) => terminal.write(bytes, resolve));
}

function cellState(cell) {
  const visuallyEmpty = cell.getChars() === " " && cell.isAttributeDefault();
  return {
    chars: visuallyEmpty ? "" : cell.getChars(),
    width: cell.getWidth(),
    code: visuallyEmpty ? 0 : cell.getCode(),
    foregroundMode: cell.getFgColorMode(),
    foreground: cell.getFgColor(),
    backgroundMode: cell.getBgColorMode(),
    background: cell.getBgColor(),
    bold: cell.isBold(),
    italic: cell.isItalic(),
    dim: cell.isDim(),
    underline: cell.isUnderline(),
    blink: cell.isBlink(),
    inverse: cell.isInverse(),
    invisible: cell.isInvisible(),
    strikethrough: cell.isStrikethrough(),
    overline: cell.isOverline(),
  };
}

function terminalState(terminal) {
  const buffer = terminal.buffer.active;
  const cells = [];
  const wrapped = [];
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.baseY + row);
    assert(line, `missing visible row ${row}`);
    wrapped.push(line.isWrapped);
    const rowCells = [];
    for (let column = 0; column < terminal.cols; column += 1) {
      const cell = line.getCell(column);
      assert(cell, `missing cell ${column},${row}`);
      rowCells.push(cellState(cell));
    }
    cells.push(rowCells);
  }
  return {
    columns: terminal.cols,
    rows: terminal.rows,
    activeScreen: buffer.type,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    wrapped,
    cells,
    modes: { ...terminal.modes },
  };
}

function createTerminal(columns, rows, responses) {
  const terminal = new Terminal({
    cols: columns,
    rows,
    allowProposedApi: true,
    // Shipctl must preserve the cursor's wrapped line when the host and
    // renderer resize together. xterm defaults this compatibility option to
    // false, which intentionally leaves the cursor line for the application
    // to redraw and therefore cannot support detached visual replay.
    reflowCursorLine: true,
    scrollback: 1_000,
  });
  terminal.onData((data) => responses.push(Buffer.from(data, "utf8")));
  return terminal;
}

function summarizeState(state) {
  return {
    activeScreen: state.activeScreen,
    cursor: [state.cursorX, state.cursorY],
    wrapped: state.wrapped,
    visibleText: state.cells.map((row) => row.map((cell) => cell.chars || " ").join("")),
    modes: state.modes,
  };
}

async function compareFixture(record) {
  const [
    name,
    initialColumns,
    initialRows,
    captureColumns,
    captureRows,
    prefixHex,
    suffixHex,
    replayHex,
    finalReplayHex,
    hostResponsesHex,
    expectHyperlink,
    expectQueryResponse,
  ] = record.split("\t");
  const prefix = fromHex(prefixHex);
  const suffix = fromHex(suffixHex);
  const replay = fromHex(replayHex);
  const finalReplay = fromHex(finalReplayHex);
  const hostResponses = fromHex(hostResponsesHex);

  const uninterruptedResponses = [];
  const uninterrupted = createTerminal(
    Number(initialColumns),
    Number(initialRows),
    uninterruptedResponses,
  );
  await write(uninterrupted, prefix);
  if (initialColumns !== captureColumns || initialRows !== captureRows) {
    uninterrupted.resize(Number(captureColumns), Number(captureRows));
  }
  await write(uninterrupted, suffix);

  const replayResponses = [];
  const restored = createTerminal(
    Number(captureColumns),
    Number(captureRows),
    replayResponses,
  );
  restored.reset();
  await write(restored, replay);
  await write(restored, suffix);

  const canonicalResponses = [];
  const canonical = createTerminal(
    Number(captureColumns),
    Number(captureRows),
    canonicalResponses,
  );
  canonical.reset();
  await write(canonical, finalReplay);

  const restoredState = terminalState(restored);
  const uninterruptedState = terminalState(uninterrupted);
  const canonicalState = terminalState(canonical);
  const canonicalMatch = isDeepStrictEqual(restoredState, canonicalState);
  const uninterruptedMatch = isDeepStrictEqual(restoredState, uninterruptedState);
  const gateErrors = [];
  if (!canonicalMatch) {
    gateErrors.push("split replay plus suffix diverged from final host replay");
  }
  if (expectHyperlink === "true") {
    if (!replay.includes(Buffer.from("https://example.com/terminal"))) {
      gateErrors.push("formatter replay did not carry the OSC 8 URI");
    }
  }
  if (expectQueryResponse === "true") {
    if (hostResponses.length === 0) gateErrors.push("host parser emitted no query response");
    if (uninterruptedResponses.length === 0) {
      gateErrors.push("xterm.js emitted no reference query response");
    }
  }

  uninterrupted.dispose();
  restored.dispose();
  canonical.dispose();
  const result = {
    name,
    replayBytes: replay.length,
    finalReplayBytes: finalReplay.length,
    prefixBytes: prefix.length,
    hostResponseBytes: hostResponses.length,
    canonicalMatch,
    uninterruptedMatch,
    gateErrors,
  };
  if (!canonicalMatch || !uninterruptedMatch) {
    result.states = {
      uninterrupted: summarizeState(uninterruptedState),
      splitReplayThenSuffix: summarizeState(restoredState),
      finalHostReplay: summarizeState(canonicalState),
    };
  }
  return result;
}

const resultPath = process.argv[2];
if (!resultPath) throw new Error("usage: node compare.mjs <Rust fixture output>");

const records = (await readFile(resultPath, "utf8"))
  .trim()
  .split("\n")
  .filter(Boolean);
const results = [];
for (const record of records) results.push(await compareFixture(record));

const largest = results.reduce((left, right) => (
  right.replayBytes > left.replayBytes ? right : left
));
const failed = results.filter((result) => result.gateErrors.length > 0);
console.log(JSON.stringify({ fixtures: results, largestReplay: largest, failed }, null, 2));
if (failed.length > 0) process.exitCode = 1;
