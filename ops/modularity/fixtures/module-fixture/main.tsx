import { mockIPC } from "@tauri-apps/api/mocks";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@shipctl/core/appearance/globals.css";
import PanelHost from "../../../../core/frontend/host/PanelHost";
import { WorkspaceContributionCatalog } from "../../../../core/frontend/host";
import { AcceptedWorkspaceContributionRuntimeProvider } from "../../../../core/frontend/host/views";
import {
  createModuleActivationIdentity,
  SemanticServiceRegistry,
} from "../../../../core/frontend/runtime/semanticServiceRuntime";
import { FIXTURE_PING_COMMAND } from "@shipctl/module-fixture";
import type { ModuleId } from "@shipctl/module-api";
import { ENABLED_MODULES } from "./enabledModules";

mockIPC((command) => {
  const commandOutput = document.querySelector("[data-testid='fixture-command']");
  if (commandOutput) commandOutput.textContent = command;
  if (command === FIXTURE_PING_COMMAND) return "fixture:pong";
  throw new Error(`Unexpected fixture command: ${command}`);
});

const fixtureModule = ENABLED_MODULES[0];
if (!fixtureModule) throw new Error("Fixture module is unavailable");
const fixtureActivation = new SemanticServiceRegistry().activate(
  createModuleActivationIdentity(fixtureModule.id, fixtureModule.version),
);
const moduleActivations = new Map<ModuleId, typeof fixtureActivation.context>([
  [fixtureModule.id, fixtureActivation.context],
]);
const workspaceContributions = WorkspaceContributionCatalog.create({
  registryRevision: 1,
  modules: ENABLED_MODULES,
  activationContextsByModule: moduleActivations,
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AcceptedWorkspaceContributionRuntimeProvider
      catalog={workspaceContributions}
      moduleActivations={moduleActivations}
    >
      <aside style={{ padding: "12px 24px" }}>
        Command: <code data-testid="fixture-command">not invoked</code>
      </aside>
      <PanelHost
        panelId="fixture.panel"
        instanceId="fixture-smoke"
        project={null}
        visible
        close={() => undefined}
        setTitle={() => undefined}
      />
    </AcceptedWorkspaceContributionRuntimeProvider>
  </StrictMode>,
);
