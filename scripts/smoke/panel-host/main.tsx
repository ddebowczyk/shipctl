import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { ContributionId, ProjectRef } from "@shep/module-api";
import { gitModule } from "@shep/module-git";
import { skillsModule } from "@shep/module-skills";

import "../../../src/styles/globals.css";
import PanelHost from "../../../src/core/modules/PanelHost";
import {
  BUILTIN_PANEL_LOADERS,
  BuiltinPanelRuntimeProvider,
} from "../../../src/core/modules/builtinPanelRuntime";
import { createEnabledPanelRegistry } from "../../../src/core/modules/moduleComposition";
import { MODULE_HOST_SERVICES } from "../../../src/core/modules/moduleHostServices";
import type { CommandState } from "../../../src/lib/types";
import { useRepoStore } from "../../../src/stores/useRepoStore";
import { useTerminalStore } from "../../../src/stores/useTerminalStore";

const PROJECT_PATH = "/smoke/shep";
const PROJECT: ProjectRef = {
  id: "smoke-shep",
  name: "Shep smoke fixture",
  path: PROJECT_PATH,
};

const COMMANDS: CommandState[] = [
  {
    name: "frontend",
    command: "pnpm dev",
    status: "running",
    ptyId: 1,
    autostart: false,
    env: {},
    cwd: null,
  },
];

mockWindows("main");
mockIPC(
  (command) => {
    switch (command) {
      case "check_command_exists":
        return true;
      case "get_models_for_provider":
        return ["smoke-model"];
      case "plugin:shep-git|git_status":
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
      case "plugin:shep-git|git_changed_files":
        return [
          {
            path: "src/AppShell.tsx",
            status: "M",
            area: "unstaged",
            old_path: null,
          },
        ];
      case "plugin:shep-git|git_list_files":
        return ["README.md", "src/AppShell.tsx", "src/core/modules/PanelHost.tsx"];
      case "plugin:shep-git|git_file_contents":
        return "Panel host smoke fixture";
      case "plugin:shep-git|git_file_diff":
        return "@@ -1 +1 @@\n-old\n+new";
      case "plugin:shep-todos|read_todos":
        return [];
      case "plugin:shep-skills|list_skills":
        return [
          {
            name: "shep-todos",
            title: "Shep to-dos",
            description: "Smoke fixture",
            installed: true,
          },
        ];
      case "get_pi_config":
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

useTerminalStore.getState().switchProject(PROJECT_PATH);
useRepoStore.setState({
  activeRepoPath: PROJECT_PATH,
  activeConfig: { name: PROJECT.name, commands: [], assistants: [] },
});
await gitModule.projectLifecycle.onProjectsChanged([PROJECT_PATH]);
await skillsModule.projectLifecycle.onProjectsChanged([PROJECT_PATH]);

const registry = createEnabledPanelRegistry(BUILTIN_PANEL_LOADERS);
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
    <BuiltinPanelRuntimeProvider
      value={{
        commands: COMMANDS,
        onStartCommand: () => undefined,
        onStopCommand: () => undefined,
        onCreateCommand: () => true,
        onUpdateCommand: () => true,
        onDeleteCommand: () => undefined,
        onStartAllCommands: () => undefined,
        onStopAllCommands: () => undefined,
        onStartSession: async () => false,
      }}
    >
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
            registry={registry}
            panelId={panelId}
            instanceId={`smoke:${panelId}`}
            project={PROJECT}
            visible
            close={() => setRemovedCount((count) => count + 1)}
            setTitle={setTitle}
            services={MODULE_HOST_SERVICES}
          />
        </section>
      </main>
    </BuiltinPanelRuntimeProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SmokeApp />
  </React.StrictMode>,
);
