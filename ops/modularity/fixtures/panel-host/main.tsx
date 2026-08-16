import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type {
  ContributionId,
  ModuleActivationContext,
  ModuleId,
  ProjectRef,
} from "@shipctl/module-api";
import { gitModule } from "@shipctl/module-git";
import { skillsModule } from "@shipctl/module-skills";

import "@shipctl/core/appearance/globals.css";
import PanelHost from "../../../../core/frontend/host/PanelHost";
import { createEnabledPanelRegistry } from "../../../../core/frontend/host/moduleComposition";
import { MODULE_HOST_SERVICES } from "../../../../core/frontend/host/moduleHostServices";
import { createGitServiceProvider } from "../../../../core/frontend/platform/git";
import {
  createModuleActivationIdentity,
  SemanticServiceRegistry,
} from "../../../../core/frontend/runtime/semanticServiceRuntime";
import { useRepoStore } from "@shipctl/core/projects";

const PROJECT_PATH = "/smoke/shipctl";
const PROJECT: ProjectRef = {
  id: "smoke-shipctl",
  name: "Shipctl smoke fixture",
  path: PROJECT_PATH,
};

mockWindows("main");
mockIPC(
  (command) => {
    switch (command) {
      case "check_command_exists":
        return true;
      case "plugin:shipctl-assistants|get_models_for_provider":
        return ["smoke-model"];
      case "plugin:shipctl-git|git_status":
        return {
          is_git_repo: true,
          branch: "smoke/panel-host",
          dirty: true,
          staged: 0,
          unstaged: 1,
          untracked: 0,
          ahead: 0,
          behind: 0,
          worktree_parent: null,
        };
      case "plugin:shipctl-git|git_changed_files":
        return [
          {
            path: "core/frontend/shell/AppShell.tsx",
            status: "M",
            area: "unstaged",
            old_path: null,
          },
        ];
      case "plugin:shipctl-git|git_list_files":
        return ["README.md", "core/frontend/shell/AppShell.tsx", "core/frontend/host/PanelHost.tsx"];
      case "plugin:shipctl-git|git_file_contents":
        return "Panel host smoke fixture";
      case "plugin:shipctl-git|git_file_diff":
        return "@@ -1 +1 @@\n-old\n+new";
      case "plugin:shipctl-todos|read_todos":
        return [];
      case "plugin:shipctl-skills|list_skills":
        return [
          {
            name: "shipctl-todos",
            title: "Shipctl to-dos",
            description: "Smoke fixture",
            installed: true,
          },
        ];
      case "plugin:shipctl-assistants|get_pi_config":
        return {
          settings: {
            defaultProvider: null,
            defaultModel: null,
            defaultThinkingLevel: null,
          },
          configuredProviders: [],
        };
      default:
        return null;
    }
  },
  { shouldMockEvents: true },
);

useRepoStore.setState({
  activeRepoPath: PROJECT_PATH,
  activeConfig: { name: PROJECT.name, commands: [] },
});
const semanticServices = new SemanticServiceRegistry([createGitServiceProvider()]);
const gitActivation = semanticServices.activate(
  createModuleActivationIdentity(gitModule.id, gitModule.version),
);
const skillsActivation = semanticServices.activate(
  createModuleActivationIdentity(skillsModule.id, skillsModule.version),
);
const moduleActivations = new Map<ModuleId, ModuleActivationContext>([
  [gitModule.id, gitActivation.context],
  [skillsModule.id, skillsActivation.context],
]);
await gitModule.projectLifecycle.onProjectsChanged(
  [PROJECT_PATH],
  MODULE_HOST_SERVICES,
  gitActivation.context,
);
await skillsModule.projectLifecycle.onProjectsChanged(
  [PROJECT_PATH],
  MODULE_HOST_SERVICES,
  skillsActivation.context,
);

const registry = createEnabledPanelRegistry();
registry.register({
  id: "smoke.crash",
  moduleId: "smoke",
  scope: "project",
  label: "Crashing fixture",
  icon: { name: "triangle-alert" },
  singleton: "per-project",
  unavailable: {
    title: "Crash contained",
    description: "The host caught the fixture failure.",
  },
  load: async () => ({
    default: function CrashingPanel() {
      throw new Error("intentional smoke failure");
    },
  }),
});

const panelChoices = [
  ...registry.list().map(({ id, label }) => ({ id, label })),
  { id: "smoke.crash" as ContributionId, label: "Crash fixture" },
  { id: "missing.panel" as ContributionId, label: "Missing fixture" },
] as const;

function SmokeApp() {
  const [panelId, setPanelId] = useState<ContributionId>(gitModule.panels[0].id);
  const [removedCount, setRemovedCount] = useState(0);
  const [title, setTitle] = useState<string | null>(null);

  return (
    <main className="h-full flex bg-[var(--app-bg)] text-[var(--app-fg)]">
        <nav className="w-52 shrink-0 border-r border-white/10 p-3" aria-label="Smoke panels">
          <h1 className="mb-3 text-sm font-semibold">Panel host smoke</h1>
          <div className="flex flex-col gap-1">
            {panelChoices.map((choice) => (
              <button
                key={choice.id}
                className={panelId === choice.id ? "btn-primary" : "btn-ghost"}
                onClick={() => setPanelId(choice.id)}
              >
                {choice.label}
              </button>
            ))}
          </div>
          <output className="mt-4 block text-xs opacity-70" aria-live="polite">
            Active: {panelId}<br />
            Removed: {removedCount}<br />
            Title: {title ?? "unchanged"}
          </output>
        </nav>
        <section className="relative min-w-0 flex-1" aria-label="Hosted panel">
          <PanelHost
            contribution={registry.panel(panelId)}
            panelId={panelId}
            instanceId={`smoke:${panelId}`}
            project={PROJECT}
            visible
            close={() => setRemovedCount((count) => count + 1)}
            setTitle={setTitle}
            services={MODULE_HOST_SERVICES}
            moduleActivations={moduleActivations}
          />
        </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SmokeApp />
  </React.StrictMode>,
);
