import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer, type ViteDevServer } from "vite";

import { PORT_COMMANDS } from "../../src/lib/tauri.ts";
import type { PortInfo } from "../../src/lib/types.ts";

type PortsPanelModule = typeof import("../../src/components/ports/PortsPanel.tsx");
type TerminalStoreModule = typeof import("../../src/stores/useTerminalStore.ts");
type UIStoreModule = typeof import("../../src/stores/useUIStore.ts");

let vite: ViteDevServer;
let portsPanel: PortsPanelModule;
let useTerminalStore: TerminalStoreModule["useTerminalStore"];
let useUIStore: UIStoreModule["useUIStore"];

const fixturePort: PortInfo = {
  port: 5173,
  pid: 4242,
  process: "node",
  cwd: "/work/alpha",
  project: "alpha",
  framework: "Vite",
  uptime: "01:02",
  memory_kb: 2048,
};

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  portsPanel = await vite.ssrLoadModule(
    "/src/components/ports/PortsPanel.tsx",
  ) as PortsPanelModule;
  ({ useTerminalStore } = await vite.ssrLoadModule(
    "/src/stores/useTerminalStore.ts",
  ) as TerminalStoreModule);
  ({ useUIStore } = await vite.ssrLoadModule(
    "/src/stores/useUIStore.ts",
  ) as UIStoreModule);
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
  useUIStore.setState({
    settingsActive: false,
    usagePanelActive: false,
    portsPanelActive: false,
  });
});

test("Ports frontend uses the current flat Tauri command contract", () => {
  assert.deepEqual(PORT_COMMANDS, {
    list: "list_listening_ports",
    kill: "kill_port",
  });
});

test("scan preserves occupied results and represents no listeners as an empty success", async () => {
  assert.deepEqual(
    await portsPanel.scanPorts(async () => [fixturePort]),
    { status: "ready", ports: [fixturePort] },
  );
  assert.deepEqual(
    await portsPanel.scanPorts(async () => []),
    { status: "ready", ports: [] },
  );
});

test("scan failures become bounded UI error state", async () => {
  assert.deepEqual(
    await portsPanel.scanPorts(async () => {
      throw new Error("lsof unavailable");
    }),
    { status: "error", message: "lsof unavailable" },
  );
});

test("stop reports success and failure without interpreting process state", async () => {
  const stopped: number[] = [];
  const success = await portsPanel.stopPort(fixturePort, async (pid) => {
    stopped.push(pid);
  });
  assert.deepEqual(stopped, [4242]);
  assert.equal(success.status, "stopped");
  assert.equal(success.notice.title, "Process killed");

  const failure = await portsPanel.stopPort(fixturePort, async () => {
    throw "permission denied";
  });
  assert.deepEqual(failure, {
    status: "error",
    notice: {
      tone: "error",
      title: "Kill failed",
      message: "permission denied",
    },
  });
});

test("ports group by matched project with unmatched listeners last", () => {
  const beta = { ...fixturePort, port: 3000, project: "beta" };
  const other = { ...fixturePort, port: 8080, project: "" };
  const groups = portsPanel.groupPortsByProject([beta, other, fixturePort]);

  assert.deepEqual(portsPanel.sortPortGroupKeys(groups), ["alpha", "beta", "Other"]);
  assert.deepEqual(groups.Other, [other]);
  assert.equal(portsPanel.formatMemory(0), "—");
  assert.equal(portsPanel.formatMemory(2048), "2 MB");
  assert.equal(portsPanel.formatUptime(" 01:02 "), "01:02");
});

test("Ports is a global in-memory overlay and survives project switches", () => {
  useTerminalStore.getState().switchProject("/work/alpha");
  useUIStore.getState().togglePortsPanel();
  useTerminalStore.getState().switchProject("/work/beta");

  assert.equal(useTerminalStore.getState().activeProjectPath, "/work/beta");
  assert.equal(useUIStore.getState().portsPanelActive, true);
  assert.equal(useUIStore.getState().settingsActive, false);
  assert.equal(useUIStore.getState().usagePanelActive, false);

  useUIStore.getState().deactivateAllOverlays();
  assert.equal(useUIStore.getState().portsPanelActive, false);
});
