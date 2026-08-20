import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type {
  ContributionId,
  ModuleActivationContext,
  ModuleId,
  ProjectRef,
  ShipctlModule,
} from "@shipctl/module-api";
import {
  gitContributions,
  GIT_MODULE_ID,
  GIT_PLUGIN_VERSION,
} from "@shipctl/module-git";
import {
  activateSkillsRuntime,
  skillsContributions,
  SKILLS_MODULE_ID,
  SKILLS_PLUGIN_VERSION,
} from "@shipctl/module-skills";

import "@shipctl/core/appearance/globals.css";
import PanelHost from "../../../../core/frontend/host/PanelHost";
import { WorkspaceContributionCatalog } from "../../../../core/frontend/host";
import { AcceptedWorkspaceContributionRuntimeProvider } from "../../../../core/frontend/host/views";
import { createGitServiceProvider } from "../../../../core/frontend/platform/git";
import { createSkillInstallationServiceProvider } from "../../../../core/frontend/platform/skillInstallation";
import {
  createModuleActivationIdentity,
  SemanticServiceRegistry,
} from "../../../../core/frontend/runtime/semanticServiceRuntime";
import { createProjectsServiceProvider, useRepoStore } from "@shipctl/core/projects";

const PROJECT_PATH = "/smoke/shipctl";
const PROJECT: ProjectRef = {
  id: "smoke-shipctl",
  name: "Shipctl smoke fixture",
  path: PROJECT_PATH,
};

const smokePanel = {
  id: "smoke.crash" as ContributionId,
  moduleId: "smoke",
  scope: "project" as const,
  label: "Crashing fixture",
  icon: { name: "triangle-alert" },
  singleton: "per-project" as const,
  unavailable: {
    title: "Crash contained",
    description: "The host caught the fixture failure.",
  },
  load: async () => ({
    default: function CrashingPanel() {
      throw new Error("intentional smoke failure");
    },
  }),
};

const smokeModule: ShipctlModule = {
  id: "smoke",
  version: "1.0.0",
  panels: [smokePanel],
};

mockWindows("main");
mockIPC(
  (command) => {
    switch (command) {
      case "check_command_exists":
        return true;
      case "plugin:shipctl-assistants|get_models_for_provider":
        return ["smoke-model"];
      case "git_inspect_status":
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
      case "git_list_changed_files":
        return [
          {
            path: "core/frontend/shell/AppShell.tsx",
            status: "M",
            area: "unstaged",
            old_path: null,
          },
        ];
      case "git_list_files":
        return ["README.md", "core/frontend/shell/AppShell.tsx", "core/frontend/host/PanelHost.tsx"];
      case "git_read_file":
        return "Panel host smoke fixture";
      case "git_read_file_diff":
        return "@@ -1 +1 @@\n-old\n+new";
      case "release_git_activation":
        return true;
      case "inspect_skill_installations":
        return [
          {
            skillId: "shipctl-todos",
            installed: true,
          },
          { skillId: "orchestrate", installed: false },
        ];
      case "install_skill_source":
      case "remove_skill_installation":
      case "release_skill_installation_activation":
        return null;
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
const semanticServices = new SemanticServiceRegistry([
  createGitServiceProvider(),
  createProjectsServiceProvider(),
  createSkillInstallationServiceProvider(),
]);
const gitActivation = semanticServices.activate(
  createModuleActivationIdentity(GIT_MODULE_ID, GIT_PLUGIN_VERSION),
);
const skillsActivation = semanticServices.activate(
  createModuleActivationIdentity(SKILLS_MODULE_ID, SKILLS_PLUGIN_VERSION),
);
const smokeActivation = semanticServices.activate(
  createModuleActivationIdentity(smokeModule.id, smokeModule.version),
);
const moduleActivations = new Map<ModuleId, ModuleActivationContext>([
  [GIT_MODULE_ID, gitActivation.context],
  [SKILLS_MODULE_ID, skillsActivation.context],
  [smokeModule.id, smokeActivation.context],
]);
skillsActivation.context.own(
  await activateSkillsRuntime(skillsActivation.context),
  "skills.runtime",
);
for (const provider of skillsContributions.skillsProviders) {
  skillsActivation.context.contributions.skillsProviders.register(provider);
}
for (const action of skillsContributions.projectActions) {
  skillsActivation.context.contributions.projectActions.register(action);
}

const workspaceContributions = WorkspaceContributionCatalog.create({
  registryRevision: 1,
  modules: [smokeModule],
  activationContextsByModule: moduleActivations,
  runtimeContributions: [
    {
      moduleId: GIT_MODULE_ID,
      activation: gitActivation.context,
      panels: gitContributions.panels,
      projectNavigation: gitContributions.projectNavigation,
      projectLayout: gitContributions.projectLayout,
      projectActions: gitContributions.projectActions,
      settings: gitContributions.settings,
    },
    {
      moduleId: SKILLS_MODULE_ID,
      activation: skillsActivation.context,
      projectActions: skillsContributions.projectActions,
    },
  ],
});

const panelChoices = [
  ...workspaceContributions.canvasSurfaceCatalog.panels().map(({ id, label }) => ({ id, label })),
  { id: "missing.panel" as ContributionId, label: "Missing fixture" },
] as const;

function SmokeApp() {
  const [panelId, setPanelId] = useState<ContributionId>(gitContributions.panels[0].id);
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
            panelId={panelId}
            instanceId={`smoke:${panelId}`}
            project={PROJECT}
            visible
            close={() => setRemovedCount((count) => count + 1)}
            setTitle={setTitle}
          />
        </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AcceptedWorkspaceContributionRuntimeProvider
      catalog={workspaceContributions}
      moduleActivations={moduleActivations}
    >
      <SmokeApp />
    </AcceptedWorkspaceContributionRuntimeProvider>
  </React.StrictMode>,
);
