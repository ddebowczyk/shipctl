import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer, type ViteDevServer } from "vite";

import { contributedPanelTabId } from "@shep/core/platform";

type TerminalStoreModule = typeof import("../useTerminalStore.ts");

let vite: ViteDevServer;
let useTerminalStore: TerminalStoreModule["useTerminalStore"];

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
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
    tabActivity: {},
  });
});

test("contributed panels open through a generic tab identity", () => {
  useTerminalStore.getState().addContributedPanelTab("/fixture", "fixture.panel", "Fixture");

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
  useTerminalStore.getState().addContributedPanelTab("/fixture", "fixture.panel", "Fixture");
  useTerminalStore.getState().addContributedPanelTab("/fixture", "fixture.panel", "Fixture");

  assert.equal(
    useTerminalStore.getState().projectState["/fixture"].tabs.length,
    1,
  );
});

test("tab selection is scoped explicitly to its project", () => {
  const store = useTerminalStore.getState();
  store.addContributedPanelTab("/alpha", "fixture.one", "One");
  store.addContributedPanelTab("/alpha", "fixture.two", "Two");
  store.addContributedPanelTab("/beta", "fixture.one", "One");
  store.addContributedPanelTab("/beta", "fixture.two", "Two");

  store.setActiveTab("/alpha", contributedPanelTabId("fixture.one"));

  assert.equal(
    useTerminalStore.getState().projectState["/alpha"].activeTabId,
    contributedPanelTabId("fixture.one"),
  );
  assert.equal(
    useTerminalStore.getState().projectState["/beta"].activeTabId,
    contributedPanelTabId("fixture.two"),
  );
});
