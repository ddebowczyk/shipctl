import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer, type ViteDevServer } from "vite";

import type {
  GitRepositoryStatus,
  GitWorktree,
  ModuleActivationContext,
  ModuleHostServices,
} from "@shipctl/module-api";

type GitStoreModule = typeof import("../src/store.ts");
type GitPanelStoreModule = typeof import("../src/panelStore.ts");
type GitFrontendModule = typeof import("../src/index.ts");
type GitClientModule = typeof import("../src/gitClient.ts");
type ModuleApi = typeof import("@shipctl/module-api");
type ModuleApiTesting = typeof import("@shipctl/module-api/testing");

let vite: ViteDevServer;
let useGitStore: GitStoreModule["useGitStore"];
let useGitPanelStore: GitPanelStoreModule["useGitPanelStore"];
let gitModule: GitFrontendModule["gitModule"];
let gitClientFor: GitClientModule["gitClientFor"];
let gitService: ModuleApi["gitService"];
let createFakeGitServiceProvider: ModuleApiTesting["createFakeGitServiceProvider"];
let createTestActivationIdentity: ModuleApiTesting["createTestActivationIdentity"];
let SemanticServiceTestHost: ModuleApiTesting["SemanticServiceTestHost"];
let activations: Array<{ dispose(): Promise<void> }> = [];

function status(overrides: Partial<GitRepositoryStatus> = {}): GitRepositoryStatus {
  return {
    isRepository: true,
    branchName: "main",
    dirty: false,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    aheadCount: 0,
    behindCount: 0,
    worktreeParentProjectId: null,
    ...overrides,
  };
}

function activateGit(
  repositories: Parameters<typeof createFakeGitServiceProvider>[0]["repositories"] = [],
): ModuleActivationContext {
  const host = new SemanticServiceTestHost([
    createFakeGitServiceProvider({ repositories }),
  ]);
  const activation = host.activate(createTestActivationIdentity("shipctl.git"));
  activations.push(activation);
  return activation.context;
}

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({ useGitStore } = await vite.ssrLoadModule(
    "/modules/git/frontend/src/store.ts",
  ) as GitStoreModule);
  ({ useGitPanelStore } = await vite.ssrLoadModule(
    "/modules/git/frontend/src/panelStore.ts",
  ) as GitPanelStoreModule);
  ({ gitModule } = await vite.ssrLoadModule(
    "/modules/git/frontend/src/index.ts",
  ) as GitFrontendModule);
  ({ gitClientFor } = await vite.ssrLoadModule(
    "/modules/git/frontend/src/gitClient.ts",
  ) as GitClientModule);
  ({ gitService } = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ) as ModuleApi);
  ({
    createFakeGitServiceProvider,
    createTestActivationIdentity,
    SemanticServiceTestHost,
  } = await vite.ssrLoadModule(
    "/module-api/frontend/src/testing.ts",
  ) as ModuleApiTesting);
});

after(async () => {
  await vite.close();
});

beforeEach(() => {
  activations = [];
  useGitStore.setState({ projectGitStatus: {} });
  useGitPanelStore.setState({ perRepo: {} });
});

afterEach(async () => {
  for (const activation of activations.reverse()) await activation.dispose();
});

function services(autoImportWorktrees = true): ModuleHostServices {
  return {
    panels: {
      open: () => "git-panel",
      reveal: () => undefined,
      close: () => undefined,
    },
    appearance: {
      getSnapshot: () => ({ themeId: "fixture", background: "#000000" }),
      subscribe: () => () => undefined,
    },
    terminalSessions: {
      list: () => [],
      getDimensions: () => ({ columns: 80, rows: 24 }),
      launch: async (request) => ({
        id: "fixture-session",
        projectPath: request.projectPath,
        ownerKey: request.ownerKey,
        label: request.label,
      }),
      launchManaged: async () => { throw new Error("not used"); },
      update: async (sessionId, patch) => ({
        id: sessionId,
        projectPath: "/fixture",
        ownerKey: "fixture",
        label: patch.label ?? "fixture",
      }),
      stop: async () => undefined,
      focus: async () => undefined,
      subscribe: () => () => undefined,
    },
    settings: {
      getSnapshot: () => ({
        values: { autoImportWorktrees },
        isSaving: false,
        error: null,
      }),
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
}

test("Git module source depends on its semantic contract and not on Tauri", () => {
  const sourceDirectory = fileURLToPath(new URL("../src", import.meta.url));
  const source = readdirSync(sourceDirectory, { recursive: true })
    .filter((entry) => typeof entry === "string" && /\.(?:ts|tsx)$/u.test(entry))
    .map((entry) => readFileSync(`${sourceDirectory}/${entry}`, "utf8"))
    .join("\n");

  assert.match(source, /gitService/);
  assert.doesNotMatch(source, /@tauri-apps\/api|plugin:shipctl-git\||git-fs-changed/);
});

test("module entry owns every Git contribution and its stable panel shortcut", () => {
  assert.equal(gitModule.id, "shipctl.git");
  assert.deepEqual(gitModule.panels.map(({ id, shortcut }) => ({ id, shortcut })), [
    { id: "core.git", shortcut: "⌘G" },
  ]);
  assert.deepEqual(gitModule.projectNavigation.map(({ id }) => id), [
    "git.project-navigation",
  ]);
  assert.deepEqual(gitModule.projectLayout.map(({ id }) => id), ["git.diff-summary"]);
  assert.deepEqual(gitModule.projectActions.map(({ id }) => id), ["git.project-actions"]);
  assert.equal(gitModule.projectFactsProvider.id, "git.project-facts");
  assert.equal(gitModule.projectImport.id, "git.related-projects");
  assert.deepEqual(gitModule.settings.map(({ id }) => id), ["git.settings"]);
});

test("module-owned project import preserves main and linked worktree behavior", async () => {
  const entries: readonly GitWorktree[] = [
    { projectId: "/repo", branchName: "main", isMain: true },
    { projectId: "/repo-feature", branchName: "feature", isMain: false },
  ];
  const activation = activateGit([
    { projectId: "/repo", worktrees: entries },
    { projectId: "/repo-feature", worktrees: entries },
  ]);

  assert.deepEqual(
    await gitModule.projectImport.relatedPaths(
      "/repo",
      { expandRelated: true },
      services(true),
      activation,
    ),
    ["/repo-feature"],
  );
  assert.deepEqual(
    await gitModule.projectImport.relatedPaths(
      "/repo",
      { expandRelated: true },
      services(false),
      activation,
    ),
    [],
  );
  assert.deepEqual(
    await gitModule.projectImport.relatedPaths(
      "/repo",
      { expandRelated: false },
      services(true),
      activation,
    ),
    [],
  );
  assert.deepEqual(
    await gitModule.projectImport.relatedPaths(
      "/repo-feature",
      { expandRelated: false },
      services(false),
      activation,
    ),
    ["/repo"],
  );
});

test("batch refresh updates fulfilled projects and preserves failed project snapshots", async () => {
  const oldBeta = status({ branchName: "beta-old", dirty: true });
  useGitStore.setState({
    projectGitStatus: {
      "/alpha": status({ branchName: "alpha-old" }),
      "/beta": oldBeta,
    },
  });
  const activation = activateGit([
    { projectId: "/alpha", status: { branchName: "alpha-new", aheadCount: 2 } },
  ]);

  await useGitStore.getState().refreshAll(
    ["/alpha", "/beta"],
    gitClientFor(activation),
  );

  assert.deepEqual(useGitStore.getState().projectGitStatus, {
    "/alpha": status({ branchName: "alpha-new", aheadCount: 2 }),
    "/beta": oldBeta,
  });
});

test("single refresh failures are silent and equal snapshots retain store identity", async () => {
  const original = status({ branchName: "main", untrackedCount: 1 });
  useGitStore.setState({ projectGitStatus: { "/repo": original } });
  const missingActivation = activateGit([]);

  await useGitStore.getState().refreshStatus(
    "/repo",
    gitClientFor(missingActivation),
  );
  assert.equal(useGitStore.getState().projectGitStatus["/repo"], original);

  const equalActivation = activateGit([{ projectId: "/repo", status: original }]);
  const beforeState = useGitStore.getState();
  await useGitStore.getState().refreshAll(
    ["/repo"],
    gitClientFor(equalActivation),
  );
  assert.equal(useGitStore.getState(), beforeState);
});

test("project removal evicts only the requested Git status snapshot", () => {
  const alpha = status({ branchName: "alpha" });
  const beta = status({ branchName: "beta" });
  useGitStore.setState({ projectGitStatus: { "/alpha": alpha, "/beta": beta } });

  useGitStore.getState().removeProject("/alpha");

  assert.deepEqual(useGitStore.getState().projectGitStatus, { "/beta": beta });
});

test("module lifecycle uses the exact activation for refresh and owns removal", async () => {
  const activation = activateGit([
    { projectId: "/alpha", status: { branchName: "alpha" } },
    { projectId: "/beta", status: { branchName: "beta", dirty: true } },
  ]);

  await gitModule.projectLifecycle.onProjectsChanged(
    ["/alpha"],
    services(),
    activation,
  );
  await gitModule.projectLifecycle.onFilesystemChanged(
    ["/beta"],
    services(),
    activation,
  );
  assert.equal(useGitStore.getState().projectGitStatus["/alpha"].branchName, "alpha");
  assert.equal(useGitStore.getState().projectGitStatus["/beta"].dirty, true);

  gitModule.projectLifecycle.onProjectRemoved("/alpha", services(), activation);
  assert.equal(useGitStore.getState().projectGitStatus["/alpha"], undefined);
  assert.equal(useGitStore.getState().projectGitStatus["/beta"].branchName, "beta");
  assert.equal(activation.services.require(gitService).inspectStatus.policy.retry.kind, "never");
});

test("generic host project chrome has no direct Git state dependency", () => {
  const files = [
    "../../../../core/frontend/shell/AppShell.tsx",
    "../../../../core/frontend/canvas/legacy/LegacyTabBar.tsx",
    "../../../../core/frontend/projects/projectMoveMenu.tsx",
    "../../../../core/frontend/terminal-host/AgentSessionList.tsx",
    "../../../../core/frontend/host/ModuleSessionButton.tsx",
    "../../../../core/frontend/projects/ProjectList.tsx",
    "../../../../core/frontend/canvas/legacy/LegacySidebar.tsx",
    "../../../../core/frontend/terminal-host/TerminalItem.tsx",
    "../../../../core/frontend/projects/useProjectWatcher.ts",
    "../../../../core/frontend/projects/projectGrouping.ts",
  ];

  for (const file of files) {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    assert.doesNotMatch(
      source,
      /@shipctl\/module-git|useGitStore|useGitPanelStore|projectGitStatus|worktree_parent|GitPanel|GitStatusRow/,
    );
  }
});

test("panel state is process-local, project-keyed, and preserves independent fields", () => {
  const panel = useGitPanelStore.getState();
  panel.setRepoSelection("/alpha", "src/main.ts");
  panel.setRepoExpanded("/alpha", ["src"]);
  panel.setLeftSearch("/alpha", "main");
  panel.setViewerMode("/alpha", "diff");
  panel.setRepoPreferredDiffArea("/alpha", "src/main.ts", "staged");
  panel.setSidebarCollapsed("/alpha", true);
  panel.setRepoScrollPosition("/alpha", "src/main.ts", 240);
  panel.setRepoSelection("/beta", "README.md");

  assert.deepEqual(useGitPanelStore.getState().perRepo["/alpha"], {
    repoSelectedPath: "src/main.ts",
    repoExpanded: ["src"],
    leftSearch: "main",
    viewerMode: "diff",
    repoPreferredDiffArea: { "src/main.ts": "staged" },
    sidebarCollapsed: true,
    repoScrollPositions: { "src/main.ts": 240 },
  });
  assert.equal(
    useGitPanelStore.getState().perRepo["/beta"].repoSelectedPath,
    "README.md",
  );
  assert.equal(useGitPanelStore.getState().perRepo["/beta"].viewerMode, "file");
});
