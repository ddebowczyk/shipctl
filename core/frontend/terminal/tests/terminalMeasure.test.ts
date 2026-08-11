/**
 * What is decided about a measurement, as opposed to the measurement.
 *
 * These run with no DOM and no xterm. The probe they inject stands where the
 * offscreen renderer stands in "../terminalXtermMeasure.ts".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MIN_TERMINAL_DIMENSION,
  resolveTerminalSize,
  TERMINAL_FALLBACK_SIZE,
  type TerminalSizeProbe,
} from "../terminalMeasure.ts";

/** A probe that records every box it was asked about. */
function recording(
  answer: { cols: number; rows: number } | null,
): TerminalSizeProbe & { calls: string[] } {
  const calls: string[] = [];
  const probe = (width: number, height: number) => {
    calls.push(`${width}x${height}`);
    return answer;
  };
  return Object.assign(probe, { calls });
}

test("a container with no area is not measured at all", () => {
  for (const [width, height] of [
    [0, 600],
    [800, 0],
    [0, 0],
    [-1, 600],
    [800, -1],
  ]) {
    const probe = recording({ cols: 200, rows: 50 });
    const size = resolveTerminalSize(width, height, probe);

    assert.deepEqual(size, TERMINAL_FALLBACK_SIZE, `${width}x${height} falls back`);
    assert.deepEqual(
      probe.calls,
      [],
      "a hidden or unlaid-out container is never probed: building and tearing " +
        "down a renderer would learn nothing",
    );
  }
});

test("an unmeasurable container falls back rather than reporting zero", () => {
  const probe = recording(null);
  const size = resolveTerminalSize(800, 600, probe);

  assert.deepEqual(probe.calls, ["800x600"], "the probe was asked");
  assert.deepEqual(size, TERMINAL_FALLBACK_SIZE);
});

test("a measured container is reported as measured", () => {
  const size = resolveTerminalSize(800, 600, recording({ cols: 120, rows: 40 }));
  assert.deepEqual(size, { cols: 120, rows: 40 });
});

test("no terminal is smaller than the floor, whatever the probe says", () => {
  const size = resolveTerminalSize(4, 4, recording({ cols: 0, rows: 1 }));

  assert.deepEqual(size, { cols: MIN_TERMINAL_DIMENSION, rows: MIN_TERMINAL_DIMENSION });
});

test("the fallback cannot be mutated through a returned size", () => {
  const size = resolveTerminalSize(0, 0, recording(null));
  size.cols = 1;

  assert.equal(
    TERMINAL_FALLBACK_SIZE.cols,
    80,
    "each caller gets its own object, so a resize handler cannot shrink the " +
      "fallback every other terminal will use",
  );
});
