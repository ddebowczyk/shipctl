import { mockIPC } from "@tauri-apps/api/mocks";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../../../src/styles/globals.css";
import PanelHost from "../../../src/core/modules/PanelHost";
import { modulePanelContributions } from "../../../src/core/modules/moduleComposition";
import { PanelRegistry } from "../../../src/core/modules/panelRegistry";
import { FIXTURE_PING_COMMAND } from "@shep/module-fixture";
import { ENABLED_MODULES } from "./enabledModules";

const services = {
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
};

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
