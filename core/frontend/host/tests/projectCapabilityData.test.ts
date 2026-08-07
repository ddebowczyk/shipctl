import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkspaceConfig } from "@shep/core/platform";
import { createProjectCapabilityDataPort } from "../projectCapabilityData.ts";

function workspace(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    name: "fixture",
    commands: [{
      name: "dev",
      command: "pnpm dev",
      autostart: false,
      env: {},
      cwd: null,
    }],
    assistants: [{
      id: "codex",
      name: "Codex",
      command: "codex",
      yoloFlag: "--dangerously-bypass-approvals-and-sandbox",
      modelFlag: "--model",
    }],
    futureCapability: { compact: true },
    ...overrides,
  };
}

test("replace preserves host, sibling, and unknown project data", async () => {
  let document = workspace();
  let saved: WorkspaceConfig | null = null;
  const port = createProjectCapabilityDataPort({
    load: async () => document,
    save: async (_projectPath, nextDocument) => {
      document = nextDocument;
      saved = nextDocument;
    },
  });

  await port.replace("/repo", "commands", []);

  assert.deepEqual(saved, workspace({ commands: [] }));
  assert.deepEqual(await port.read("/repo", "assistants"), document.assistants);
  assert.deepEqual(await port.read("/repo", "futureCapability"), { compact: true });
});

test("same-project writes are serialized and each sees the previous result", async () => {
  let document = workspace();
  let releaseFirstSave: (() => void) | null = null;
  const firstSaveBlocked = new Promise<void>((resolve) => {
    releaseFirstSave = resolve;
  });
  let saveCount = 0;
  const port = createProjectCapabilityDataPort({
    load: async () => document,
    save: async (_projectPath, nextDocument) => {
      saveCount += 1;
      if (saveCount === 1) await firstSaveBlocked;
      document = nextDocument;
    },
  });

  const commandsWrite = port.replace("/repo", "commands", []);
  const futureWrite = port.replace("/repo", "futureCapability", { compact: false });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(saveCount, 1);

  releaseFirstSave?.();
  await Promise.all([commandsWrite, futureWrite]);

  assert.deepEqual(document.commands, []);
  assert.deepEqual(document.futureCapability, { compact: false });
  assert.equal(saveCount, 2);
});

test("a failed save does not publish state or poison the next write", async () => {
  let document = workspace();
  let shouldFail = true;
  const published: WorkspaceConfig[] = [];
  const port = createProjectCapabilityDataPort({
    load: async () => document,
    save: async (_projectPath, nextDocument) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("write denied");
      }
      document = nextDocument;
    },
    onSaved: (_projectPath, nextDocument) => published.push(nextDocument),
  });

  await assert.rejects(
    port.replace("/repo", "commands", []),
    /write denied/,
  );
  assert.equal(published.length, 0);
  assert.equal(document.commands.length, 1);

  await port.replace("/repo", "commands", []);
  assert.equal(document.commands.length, 0);
  assert.equal(published.length, 1);
});

test("host-owned or empty data keys are rejected", async () => {
  const port = createProjectCapabilityDataPort({
    load: async () => workspace(),
    save: async () => undefined,
  });

  await assert.rejects(port.read("/repo", ""), /must not be empty/);
  await assert.rejects(
    port.replace("/repo", "name", "changed"),
    /host-owned/,
  );
});
