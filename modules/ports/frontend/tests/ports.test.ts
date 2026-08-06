import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer, type ViteDevServer } from "vite";

import { PORT_COMMANDS } from "../src/client.ts";
import type { PortInfo } from "../src/types.ts";

type PortsPanelModule = typeof import("../src/PortsPanel.tsx");
type PortsModuleEntry = typeof import("../src/index.ts");

let vite: ViteDevServer;
let portsPanel: PortsPanelModule;
let portsModule: PortsModuleEntry["portsModule"];
let PORTS_SURFACE_ID: PortsModuleEntry["PORTS_SURFACE_ID"];

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
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  portsPanel = await vite.ssrLoadModule(
    "/modules/ports/frontend/src/PortsPanel.tsx",
  ) as PortsPanelModule;
  ({ portsModule, PORTS_SURFACE_ID } = await vite.ssrLoadModule(
    "/modules/ports/frontend/src/index.ts",
  ) as PortsModuleEntry);
});

after(async () => {
  await vite.close();
});

test("Ports owns a global surface and navigation contribution", () => {
  assert.equal(portsModule.globalSurfaces[0].id, PORTS_SURFACE_ID);
  assert.equal(portsModule.globalSurfaces[0].moduleId, portsModule.id);
  assert.deepEqual(
    portsModule.globalNavigation.map(({ id, surfaceId }) => ({ id, surfaceId })),
    [{ id: "ports.global-navigation", surfaceId: PORTS_SURFACE_ID }],
  );
});

test("Ports frontend uses the namespaced plugin command contract", () => {
  assert.deepEqual(PORT_COMMANDS, {
    list: "plugin:shep-ports|list_listening_ports",
    kill: "plugin:shep-ports|kill_port",
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
