import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dismissContextMenuForPointerTarget } from "../contextMenuDismissal.ts";

const targetWithClosest = (match: boolean): EventTarget => ({
  closest: () => match ? ({} as Element) : null,
}) as unknown as EventTarget;

test("an outside pointer dismisses the entire context-menu tree", () => {
  let closeCount = 0;
  const onClose = () => { closeCount += 1; };

  dismissContextMenuForPointerTarget(targetWithClosest(true), onClose);
  assert.equal(closeCount, 0);

  dismissContextMenuForPointerTarget(targetWithClosest(false), onClose);
  assert.equal(closeCount, 1);
});

test("submenu panels preserve nested context-menu branches", async () => {
  const source = await readFile(
    new URL("../ContextMenu.tsx", import.meta.url),
    "utf8",
  );
  const submenuPanel = source.slice(source.indexOf("const SubmenuPanel"));

  assert.match(
    submenuPanel,
    /child\.children[\s\S]*<SubmenuItem[\s\S]*item=\{child\}/,
  );
});

test("moving between portaled submenu levels keeps the parent branch open", async () => {
  const source = await readFile(
    new URL("../ContextMenu.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /relatedElement\?\.closest\("\.context-menu--submenu"\)/,
  );
});
