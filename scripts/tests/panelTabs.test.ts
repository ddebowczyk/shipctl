import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer, type ViteDevServer } from "vite";

import { contributedPanelTabId } from "@shep/core/platform";

type TerminalStoreModule = typeof import("../../core/frontend/terminal/useTerminalStore.ts");

let vite: ViteDevServer;
let useTerminalStore: TerminalStoreModule["useTerminalStore"];

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({ useTerminalStore } = await vite.ssrLoadModule(
    "/core/frontend/terminal/useTerminalStore.ts",
  ) as TerminalStoreModule);
});

after(async () => {
  await vite.close();
});

beforeEach(() => {
  useTerminalStore.setState({
    projectState: {},
    activeProjectPath: null,
    tabActivity: {},
  });
});

test("contributed panels open through a generic tab identity", () => {
  useTerminalStore.getState().switchProject("/fixture");
  useTerminalStore.getState().addContributedPanelTab("fixture.panel", "Fixture");

  const project = useTerminalStore.getState().projectState["/fixture"];
  assert.deepEqual(project.tabs, [{
    id: contributedPanelTabId("fixture.panel"),
    kind: "panel",
    panelId: "fixture.panel",
    label: "Fixture",
  }]);
  assert.equal(project.activeTabId, contributedPanelTabId("fixture.panel"));
});

test("opening a singleton contributed panel reveals its existing tab", () => {
  useTerminalStore.getState().switchProject("/fixture");
  useTerminalStore.getState().addContributedPanelTab("fixture.panel", "Fixture");
  useTerminalStore.getState().addContributedPanelTab("fixture.panel", "Fixture");

  assert.equal(
    useTerminalStore.getState().projectState["/fixture"].tabs.length,
    1,
  );
});
