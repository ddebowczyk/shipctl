import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer, type ViteDevServer } from "vite";

import type {
  ListeningProcessInspection,
  ProcessesService,
  ProcessInspectionId,
} from "@shipctl/module-api";
import type { PortInfo } from "../src/types.ts";

type PortsPanelModule = typeof import("../src/PortsPanel.tsx");
type PortsModuleEntry = typeof import("../src/index.ts");

let vite: ViteDevServer;
let portsPanel: PortsPanelModule;
let portsModule: PortsModuleEntry["portsModule"];
let PORTS_SURFACE_ID: PortsModuleEntry["PORTS_SURFACE_ID"];
let createFakeProcessesServiceProvider: typeof import("@shipctl/module-api/testing")["createFakeProcessesServiceProvider"];
let createTestActivationIdentity: typeof import("@shipctl/module-api/testing")["createTestActivationIdentity"];
let SemanticServiceTestHost: typeof import("@shipctl/module-api/testing")["SemanticServiceTestHost"];
let processesService: typeof import("@shipctl/module-api")["processesService"];

const fixtureInspection: ListeningProcessInspection = {
  inspectionId: "inspection-1" as ProcessInspectionId,
  port: 5173,
  processId: 4242,
  name: "node",
  workingDirectory: "/work/alpha",
  commandLine: "vite dev",
  observedProjectFiles: ["vite.config.ts"],
  uptime: "01:02",
  memoryKilobytes: 2048,
};

const fixturePort: PortInfo = {
  ...fixtureInspection,
  projectName: "alpha",
  framework: "Vite",
};

function fakeProcesses(options: Parameters<typeof createFakeProcessesServiceProvider>[0] = {}) {
  const host = new SemanticServiceTestHost([
    createFakeProcessesServiceProvider(options),
  ]);
  return host.activate(
    createTestActivationIdentity("shipctl.ports"),
  ).context.services.require(processesService) as ProcessesService;
}

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
  ({ processesService } = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ));
  ({
    createFakeProcessesServiceProvider,
    createTestActivationIdentity,
    SemanticServiceTestHost,
  } = await vite.ssrLoadModule("/module-api/frontend/src/testing.ts"));
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

test("scan preserves occupied results and represents no listeners as an empty success", async () => {
  assert.deepEqual(
    await portsPanel.scanPorts(
      fakeProcesses({ inspections: () => [fixtureInspection] }),
      ["/work/alpha"],
    ),
    { status: "ready", ports: [fixturePort] },
  );
  assert.deepEqual(
    await portsPanel.scanPorts(fakeProcesses()),
    { status: "ready", ports: [] },
  );
});

test("scan failures become bounded UI error state", async () => {
  assert.deepEqual(
    await portsPanel.scanPorts(fakeProcesses({
      deniedOperations: ["inspect-listening-ports"],
    })),
    {
      status: "error",
      message: "Fake process operation denied: inspect-listening-ports",
    },
  );
});

test("Ports owns filtering, project matching, and framework policy", () => {
  assert.equal(portsPanel.isDevelopmentProcess("Google Chrome Helper"), false);
  assert.equal(portsPanel.isDevelopmentProcess("node"), true);
  assert.equal(
    portsPanel.matchProject("/work/alpha/apps/web", ["/work", "/work/alpha"]),
    "alpha",
  );
  assert.equal(portsPanel.detectFramework(fixtureInspection), "Vite");
  assert.equal(
    portsPanel.detectFramework({
      ...fixtureInspection,
      name: "custom",
      commandLine: "serve",
      observedProjectFiles: ["Cargo.toml"],
    }),
    "Rust",
  );
  assert.equal(
    portsPanel.projectPortInspection(
      { ...fixtureInspection, name: "Slack Helper" },
      ["/work/alpha"],
    ),
    null,
  );
});

test("stop reports success and failure without interpreting process state", async () => {
  const successProcesses = fakeProcesses({ inspections: () => [fixtureInspection] });
  await successProcesses.inspectListeningPorts.execute({
    projectRootMarkers: [],
    observedProjectFileNames: [],
  });
  const success = await portsPanel.stopPort(fixturePort, successProcesses);
  assert.equal(success.status, "stopped");
  assert.equal(success.notice.title, "Process killed");

  const deniedProcesses = fakeProcesses({
    inspections: () => [fixtureInspection],
    deniedOperations: ["terminate-inspected-process"],
  });
  await deniedProcesses.inspectListeningPorts.execute({
    projectRootMarkers: [],
    observedProjectFileNames: [],
  });
  const failure = await portsPanel.stopPort(fixturePort, deniedProcesses);
  assert.deepEqual(failure, {
    status: "error",
    notice: {
      tone: "error",
      title: "Kill failed",
      message: "Fake process operation denied: terminate-inspected-process",
    },
  });
});

test("ports group by matched project with unmatched listeners last", () => {
  const beta = { ...fixturePort, port: 3000, projectName: "beta" };
  const other = { ...fixturePort, port: 8080, projectName: "" };
  const groups = portsPanel.groupPortsByProject([beta, other, fixturePort]);

  assert.deepEqual(portsPanel.sortPortGroupKeys(groups), ["alpha", "beta", "Other"]);
  assert.deepEqual(groups.Other, [other]);
  assert.equal(portsPanel.formatMemory(0), "—");
  assert.equal(portsPanel.formatMemory(2048), "2 MB");
  assert.equal(portsPanel.formatUptime(" 01:02 "), "01:02");
});
