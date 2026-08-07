import { mockIPC } from "@tauri-apps/api/mocks";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@shep/core/appearance/globals.css";
import PanelHost from "../../../core/frontend/host/PanelHost";
import { modulePanelContributions } from "../../../core/frontend/host/moduleComposition";
import { PanelRegistry } from "../../../core/frontend/host/panelRegistry";
import { FIXTURE_PING_COMMAND } from "@shep/module-fixture";
import type { ModuleHostServices } from "@shep/module-api";
import { ENABLED_MODULES } from "./enabledModules";

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
    getDimensions: () => ({ columns: 80, rows: 24 }),
    launch: async (request) => ({
      id: "fixture-session",
      projectPath: request.projectPath,
      ownerKey: request.ownerKey,
      label: request.label,
    }),
    launchManaged: async () => { throw new Error("not used"); },
    update: async (sessionId, update) => ({
      id: sessionId,
      projectPath: "/fixture",
      ownerKey: "fixture",
      label: update.label ?? "Fixture",
      ownerMetadata: update.ownerMetadata,
      presentation: update.presentation,
    }),
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
      registry={registry}
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
