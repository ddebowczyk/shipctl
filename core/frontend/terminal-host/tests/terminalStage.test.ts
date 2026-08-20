import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createServer, type ViteDevServer } from "vite";
import type { TerminalTabData } from "@shipctl/core/platform";

import type { TerminalStageProjectState } from "../TerminalStage.tsx";

type TerminalStageModule = typeof import("../TerminalStage.tsx");

let vite: ViteDevServer;
let terminalStageSlotsFor: TerminalStageModule["terminalStageSlotsFor"];
let terminalStageSlotVisible: TerminalStageModule["terminalStageSlotVisible"];

before(async () => {
  vite = await createServer({
    server: { hmr: false, middlewareMode: true },
    appType: "custom",
  });
  ({ terminalStageSlotsFor, terminalStageSlotVisible } = await vite.ssrLoadModule(
    "/core/frontend/terminal-host/TerminalStage.tsx",
  ) as TerminalStageModule);
});

after(async () => {
  await vite.close();
});

function terminal(
  id: string,
  terminalId: string,
  repoPath: string,
): TerminalTabData {
  return {
    id,
    kind: "terminal",
    label: id,
    terminalId,
    repoPath,
    commandName: null,
    terminalRevision: 1,
    lifecycle: "running",
  } as TerminalTabData;
}

test("terminal stage retains every mounted slot while visibility and focus change", () => {
  const projectState: TerminalStageProjectState = {
    "/repo/b": {
      tabs: [terminal("terminal:b", "b", "/repo/b")],
    },
    "/repo/a": {
      tabs: [terminal("terminal:a", "a", "/repo/a")],
    },
  };
  const slots = terminalStageSlotsFor(projectState);

  assert.deepEqual(slots.map((slot) => slot.key), ["a:terminal:a", "b:terminal:b"]);
  assert.deepEqual(
    slots.map((slot) => terminalStageSlotVisible(slot, {
      visible: true,
      activeProjectPath: "/repo/a",
      activeTabId: "terminal:a",
    })),
    [true, false],
  );
  assert.deepEqual(
    slots.map((slot) => terminalStageSlotVisible(slot, {
      visible: false,
      activeProjectPath: "/repo/a",
      activeTabId: "terminal:a",
    })),
    [false, false],
  );
  assert.deepEqual(
    slots.map((slot) => terminalStageSlotVisible(slot, {
      visible: true,
      activeProjectPath: "/repo/b",
      activeTabId: "terminal:b",
    })),
    [false, true],
  );
  assert.deepEqual(
    slots.map((slot) => slot.key), ["a:terminal:a", "b:terminal:b"]);
});
