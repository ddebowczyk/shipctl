import assert from "node:assert/strict";
import test from "node:test";

import { terminalExtractionInventory } from "../bin/terminal-extraction-inventory.mjs";

test("records terminal implementation dependencies at their extracted owners", async () => {
  const inventory = await terminalExtractionInventory();
  const targets = new Set(inventory.map(({ target }) => target));

  assert.deepEqual(
    [...targets].sort(),
    ["ghostty", "xterm"],
  );
  assert.ok(
    inventory.some(
      ({ target, file }) =>
        target === "ghostty" && file === "modules/semantic-terminal/backend/Cargo.toml",
    ),
    "the inventory identifies Ghostty's semantic module dependency",
  );
  assert.ok(
    inventory.some(
      ({ target, file }) => target === "xterm" && file.startsWith("modules/thin-terminal/"),
    ),
    "the inventory identifies the thin terminal xterm path",
  );
  assert.ok(
    !inventory.some(({ target, file }) => target === "xterm" && file.startsWith("core/frontend/")),
    "core frontend no longer owns an xterm path",
  );
  assert.ok(
    !inventory.some(({ target }) => target === "core-frontend-terminal" || target === "core-backend-terminal"),
    "the retired core terminal directories have no live import path",
  );
  assert.ok(
    !inventory.some(({ target }) => target === "terminal-transport"),
    "the compatibility transport is deleted rather than inventory-only",
  );
});
