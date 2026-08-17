import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("selected Layman runtime takes semantic workspace state instead of raw snapshots", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../LaymanCanvasRuntimeAdapter.tsx", import.meta.url)),
    "utf8",
  );

  assert.match(source, /props\.workspace/);
  assert.match(source, /createLaymanWorkspaceState/);
  assert.doesNotMatch(source, /createLaymanWorkspaceBridge/);
  assert.doesNotMatch(source, /createTauriWorkspaceLayoutSnapshotPort/);
  assert.doesNotMatch(source, /@tauri-apps\//);
});
