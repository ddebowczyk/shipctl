/**
 * The capability's logic entry point stays loadable without a browser.
 *
 * `index.ts` claims the `node --test` lanes import it. That claim was false
 * until `terminalMeasure.ts` stopped value-importing xterm: the package ships
 * UMD, which Node's ESM loader cannot named-import, so one such import anywhere
 * in the entry point's graph made the whole capability unloadable here — and
 * the claim was never checked.
 *
 * This is also the cheapest standing evidence for area 04's first acceptance
 * criterion. A module that reaches xterm cannot be exported from here without
 * failing this test, which is the point: the boundary is enforced rather than
 * described.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

test("the terminal logic entry point loads in a bare node process", async () => {
  const entry = await import("../index.ts");

  assert.ok(
    Object.keys(entry).length > 0,
    "the entry point resolves; a value-import of xterm in its graph would " +
      "have thrown before this line",
  );

  // The three modules that legitimately bind xterm are reachable by path and
  // deliberately absent from the entry point. Naming them here means deleting
  // one, or folding it in, is a decision someone has to make against this test.
  for (const escaped of [
    "computeTerminalSize",
    "bindXtermTerminal",
    "disposeXtermTerminal",
    "browserTerminalRendererFactories",
  ]) {
    assert.ok(
      !(escaped in entry),
      `${escaped} binds xterm and belongs outside the logic entry point`,
    );
  }
});
