import { mockIPC } from "@tauri-apps/api/mocks";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@shipctl/core/appearance/globals.css";
import PanelHost from "../../../../core/frontend/host/PanelHost";
import { modulePanelContributions } from "../../../../core/frontend/host/moduleComposition";
import { PanelRegistry } from "../../../../core/frontend/host/panelRegistry";
import { FIXTURE_PING_COMMAND } from "@shipctl/module-fixture";
import type { ModuleHostServices, ModuleTerminalId } from "@shipctl/module-api";
import { ENABLED_MODULES } from "./enabledModules";

const fixtureTerminalId = "00000000-0000-0000-0000-000000000001" as ModuleTerminalId;

const services = {
  panels: {
    open: () => "fixture-panel",
    reveal: () => undefined,
    close: () => undefined,
  },
  appearance: {
    getSnapshot: () => ({ themeId: "fixture", background: "#000000" }),
    subscribe: () => () => undefined,
  },
  globalData: {
    read: async () => undefined,
    replace: async () => undefined,
  },
  projectData: {
    read: async () => undefined,
    replace: async () => undefined,
  },
  terminalSessions: {
    list: () => [],
    getDimensions: () => ({ columns: 80, rows: 24 }),
    launch: async (request) => ({
      id: "fixture-session",
      terminalId: fixtureTerminalId,
      moduleId: request.ownerKey.split(":", 1)[0] || "fixture",
      projectPath: request.projectPath,
      ownerKey: request.ownerKey,
      label: request.label,
    }),
    launchManaged: async () => { throw new Error("not used"); },
    update: async (sessionId, update) => ({
      id: sessionId,
      terminalId: fixtureTerminalId,
      moduleId: "fixture",
      projectPath: "/fixture",
      ownerKey: "fixture",
      label: update.label ?? "Fixture",
      ownerMetadata: update.ownerMetadata,
      presentation: update.presentation,
    }),
    observe: async () => ({ dispose: async () => undefined }),
    stop: async () => undefined,
    focus: async () => undefined,
    subscribe: () => () => undefined,
  },
  settings: {
    getSnapshot: () => ({ values: {}, isSaving: false, error: null }),
    subscribe: () => () => undefined,
    update: async () => undefined,
  },
  skills: {
    getSnapshot: () => ({ byProject: {} }),
    subscribe: () => () => undefined,
    install: async () => undefined,
  },
  notices: { push: () => undefined },
  externalLinks: { open: async () => undefined },
} satisfies ModuleHostServices;

mockIPC((command) => {
  const commandOutput = document.querySelector("[data-testid='fixture-command']");
  if (commandOutput) commandOutput.textContent = command;
  if (command === FIXTURE_PING_COMMAND) return "fixture:pong";
  throw new Error(`Unexpected fixture command: ${command}`);
});

const registry = PanelRegistry.create(modulePanelContributions(ENABLED_MODULES));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <aside style={{ padding: "12px 24px" }}>
      Command: <code data-testid="fixture-command">not invoked</code>
    </aside>
    <PanelHost
      contribution={registry.panel("fixture.panel")}
      panelId="fixture.panel"
      instanceId="fixture-smoke"
      project={null}
      visible
      close={() => undefined}
      setTitle={() => undefined}
      services={services}
    />
  </StrictMode>,
);
