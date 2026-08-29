import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer, type ViteDevServer } from "vite";

import type {
  GitRepositoryStatus,
  GitWorktree,
  ModuleActivationContext,
} from "@shipctl/module-api";

type GitStoreModule = typeof import("../src/store.ts");
type GitPanelStoreModule = typeof import("../src/panelStore.ts");
type GitRuntimeModule = typeof import("../src/pluginContributions.ts");
type GitPreferencesModule = typeof import("../src/gitPreferences.ts");
type GitClientModule = typeof import("../src/gitClient.ts");
type ModuleApi = typeof import("@shipctl/module-api");
type ModuleApiTesting = typeof import("@shipctl/module-api/testing");

let vite: ViteDevServer;
let useGitStore: GitStoreModule["useGitStore"];
let useGitPanelStore: GitPanelStoreModule["useGitPanelStore"];
let resizedDiffStripWidth: GitPanelStoreModule["resizedDiffStripWidth"];
let gitRuntime: GitRuntimeModule;
let gitPreferences: GitPreferencesModule;
let gitClientFor: GitClientModule["gitClientFor"];
let gitService: ModuleApi["gitService"];
let pluginDataService: ModuleApi["pluginDataService"];
let testingApi: ModuleApiTesting;
let activations: Array<{ dispose(): Promise<void> }> = [];

const GIT_ADMISSION = {
  artifact: {
    contentDigest: "0".repeat(64),
    entryUrl: "shipctl://test/git",
    moduleId: "shipctl.git" as never,
    version: "0.0.0",
  },
  effectiveGrants: ["plugin-data.read", "plugin-data.write"],
} as const;

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
  repositories: Parameters<ModuleApiTesting["createFakeGitServiceProvider"]>[0]["repositories"] = [],
): ModuleActivationContext {
  const host = new testingApi.SemanticServiceTestHost([
    testingApi.createFakeGitServiceProvider({ repositories }),
  ]);
  const activation = host.activate(testingApi.createTestActivationIdentity("shipctl.git"));
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
  ({ useGitPanelStore, resizedDiffStripWidth } = await vite.ssrLoadModule(
    "/modules/git/frontend/src/panelStore.ts",
  ) as GitPanelStoreModule);
  gitRuntime = await vite.ssrLoadModule(
    "/modules/git/frontend/src/pluginContributions.ts",
  ) as GitRuntimeModule;
  gitPreferences = await vite.ssrLoadModule(
    "/modules/git/frontend/src/gitPreferences.ts",
  ) as GitPreferencesModule;
  ({ gitClientFor } = await vite.ssrLoadModule(
    "/modules/git/frontend/src/gitClient.ts",
  ) as GitClientModule);
  ({ gitService, pluginDataService } = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ) as ModuleApi);
  testingApi = await vite.ssrLoadModule(
    "/module-api/frontend/src/testing.ts",
  ) as ModuleApiTesting;
});

after(async () => {
  await vite.close();
});

beforeEach(() => {
  activations = [];
  useGitStore.setState({ projectGitStatus: {} });
  useGitPanelStore.setState({ diffStripWidth: 56, perRepo: {} });
  gitPreferences.configureGitPreferences(null);
});

afterEach(async () => {
  for (const activation of activations.reverse()) await activation.dispose();
});

async function activateRuntime(options: {
  readonly projectIds?: readonly string[];
  readonly repositories?: Parameters<ModuleApiTesting["createFakeGitServiceProvider"]>[0]["repositories"];
  readonly gitDenied?: boolean;
  readonly projectsUnavailable?: boolean;
  readonly changes?: InstanceType<ModuleApiTesting["FakeProjectsChangeController"]>;
  readonly gitChanges?: InstanceType<ModuleApiTesting["FakeGitChangeController"]>;
} = {}) {
  const gitTrace: import("@shipctl/module-api/testing").FakeGitTrace[] = [];
  const changes = options.changes ?? new testingApi.FakeProjectsChangeController(options.projectIds ?? []);
  const gitChanges = options.gitChanges ?? new testingApi.FakeGitChangeController();
  const host = new testingApi.SemanticServiceTestHost([
    testingApi.createFakeGitServiceProvider({
      repositories: options.repositories,
      deniedOperations: options.gitDenied ? ["inspect-status"] : [],
      changes: gitChanges,
      trace: gitTrace,
    }),
    testingApi.createFakeProjectsServiceProvider({
      changes,
      unavailable: options.projectsUnavailable,
    }),
    testingApi.createFakePluginDataServiceProvider(),
  ]);
  const activation = host.activate(
    testingApi.createTestActivationIdentity("shipctl.git"),
    GIT_ADMISSION,
  );
  const cleanup = await gitRuntime.activateGitRuntime(activation.context);
  activation.context.own(cleanup);
  activations.push(activation);
  return { activation, changes, gitChanges, gitTrace };
}

test("Git module source depends on its semantic contract and not on Tauri", () => {
  const sourceDirectory = fileURLToPath(new URL("../src", import.meta.url));
  const source = readdirSync(sourceDirectory, { recursive: true })
    .filter((entry) => typeof entry === "string" && /\.(?:ts|tsx)$/u.test(entry))
    .map((entry) => readFileSync(`${sourceDirectory}/${entry}`, "utf8"))
    .join("\n");

  assert.match(source, /gitService/);
  assert.match(source, /repositoryChanges/);
  assert.doesNotMatch(source, /@tauri-apps\/api|plugin:shipctl-git\|/);
});

test("direct Git declarations own every contribution and its stable panel shortcut", () => {
  assert.deepEqual(gitRuntime.gitContributions.panels.map(({ id, shortcut }) => ({ id, shortcut })), [
    { id: "core.git", shortcut: "⌘G" },
  ]);
  assert.deepEqual(gitRuntime.gitContributions.projectNavigation.map(({ id }) => id), [
    "git.project-navigation",
  ]);
  assert.deepEqual(gitRuntime.gitContributions.projectLayout.map(({ id }) => id), ["git.diff-summary"]);
  assert.deepEqual(gitRuntime.gitContributions.projectActions.map(({ id }) => id), ["git.project-actions"]);
  assert.equal(gitRuntime.gitContributions.projectFacts[0]?.id, "git.project-facts");
  assert.equal(gitRuntime.gitContributions.projectImports[0]?.id, "git.related-projects");
  assert.deepEqual(gitRuntime.gitContributions.settings.map(({ id }) => id), ["git.settings"]);
  assert.deepEqual(gitRuntime.gitContributions.configuration.map(({ id }) => id), ["git.preferences"]);
});

test("direct project import preserves main and linked worktree behavior", async () => {
  const entries: readonly GitWorktree[] = [
    { projectId: "/repo", branchName: "main", isMain: true },
    { projectId: "/repo-feature", branchName: "feature", isMain: false },
  ];
  const runtime = await activateRuntime({
    projectIds: ["/repo", "/repo-feature"],
    repositories: [
    { projectId: "/repo", worktrees: entries },
    { projectId: "/repo-feature", worktrees: entries },
    ],
  });
  const relatedPaths = gitRuntime.gitContributions.projectImports[0]?.relatedPaths;
  assert.ok(relatedPaths);

  assert.deepEqual(
    await relatedPaths(
      "/repo",
      { expandRelated: true },
      {} as never,
      runtime.activation.context,
    ),
    ["/repo-feature"],
  );
  await gitPreferences.updateGitPreferences({ autoImportWorktrees: false });
  assert.deepEqual(
    await relatedPaths(
      "/repo",
      { expandRelated: true },
      {} as never,
      runtime.activation.context,
    ),
    [],
  );
  assert.deepEqual(
    await relatedPaths(
      "/repo",
      { expandRelated: false },
      {} as never,
      runtime.activation.context,
    ),
    [],
  );
  assert.deepEqual(
    await relatedPaths(
      "/repo-feature",
      { expandRelated: false },
      {} as never,
      runtime.activation.context,
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

test("direct runtime owns catalog and semantic repository-change subscriptions", async () => {
  const runtime = await activateRuntime({
    projectIds: ["/alpha"],
    repositories: [
      { projectId: "/alpha", status: { branchName: "alpha" } },
      { projectId: "/beta", status: { branchName: "beta", dirty: true } },
    ],
  });
  assert.equal(useGitStore.getState().projectGitStatus["/alpha"].branchName, "alpha");
  assert.equal(runtime.gitTrace.filter(({ operation }) => operation === "inspect-status").length, 1);

  await runtime.gitChanges.publish("/alpha");
  assert.equal(runtime.gitTrace.filter(({ operation }) => operation === "inspect-status").length, 2);
  await runtime.changes.publishFilesystemChanged(["/alpha"]);
  assert.equal(runtime.gitTrace.filter(({ operation }) => operation === "inspect-status").length, 2);

  await runtime.changes.setProjects(["/beta"]);
  assert.equal(useGitStore.getState().projectGitStatus["/alpha"], undefined);
  assert.equal(useGitStore.getState().projectGitStatus["/beta"].dirty, true);
  const beforeRemovedEvent = runtime.gitTrace.length;
  await runtime.gitChanges.publish("/alpha");
  assert.equal(runtime.gitTrace.length, beforeRemovedEvent);
  assert.equal(runtime.activation.context.services.require(gitService).inspectStatus.policy.retry.kind, "never");

  await runtime.activation.dispose();
  const beforeDisposedEvent = runtime.gitTrace.length;
  await runtime.gitChanges.publish("/beta");
  assert.equal(runtime.gitTrace.length, beforeDisposedEvent);
  assert.equal(useGitStore.getState().projectGitStatus["/beta"], undefined);
});

test("repeated direct activation does not retain Git event listeners", async () => {
  const gitChanges = new testingApi.FakeGitChangeController();
  const first = await activateRuntime({
    projectIds: ["/repo"],
    repositories: [{ projectId: "/repo", status: { branchName: "first" } }],
    gitChanges,
  });
  await gitChanges.publish("/repo");
  assert.equal(first.gitTrace.filter(({ operation }) => operation === "inspect-status").length, 2);
  await first.activation.dispose();
  const beforeDetached = first.gitTrace.length;
  await gitChanges.publish("/repo");
  assert.equal(first.gitTrace.length, beforeDetached);

  const second = await activateRuntime({
    projectIds: ["/repo"],
    repositories: [{ projectId: "/repo", status: { branchName: "second" } }],
    gitChanges,
  });
  await gitChanges.publish("/repo");
  assert.equal(second.gitTrace.filter(({ operation }) => operation === "inspect-status").length, 2);
  assert.equal(useGitStore.getState().projectGitStatus["/repo"].branchName, "second");
});

test("unavailable or denied project resources leave no stale direct runtime", async () => {
  const retained = status({ branchName: "retained" });
  useGitStore.setState({ projectGitStatus: { "/retained": retained } });
  const unavailable = await activateRuntime({ projectsUnavailable: true });
  assert.equal(useGitStore.getState().projectGitStatus["/retained"], retained);
  assert.deepEqual(unavailable.gitTrace, []);
  await unavailable.activation.dispose();

  const denied = await activateRuntime({
    projectIds: ["/denied"],
    repositories: [{ projectId: "/denied", status: { branchName: "denied" } }],
    gitDenied: true,
  });
  assert.equal(useGitStore.getState().projectGitStatus["/denied"], undefined);
  assert.equal(denied.gitTrace[0]?.operation, "inspect-status");
  await denied.activation.dispose();
});

test("Git preferences use the activation-derived plugin-data namespace and reject stale writes", async () => {
  const runtime = await activateRuntime();
  const preferences = await gitPreferences.updateGitPreferences({ autoImportWorktrees: false });
  assert.deepEqual(preferences, { autoImportWorktrees: false });

  const data = runtime.activation.context.services.require(pluginDataService);
  const revision = gitPreferences.useGitPreferencesStore.getState().revision;
  assert.ok(revision !== null);
  const external = await data.writeRecord.execute({
    scope: { kind: "global" },
    key: "preferences",
    expectedRevision: revision,
    schemaVersion: 1,
    value: { autoImportWorktrees: true },
  });
  assert.equal(external.result.ok, true);

  await assert.rejects(
    gitPreferences.updateGitPreferences({ autoImportWorktrees: true }),
    /stale record/,
  );
  assert.deepEqual(gitPreferences.useGitPreferencesStore.getState().preferences, preferences);
});

test("disposing a replaced runtime keeps the current Git preferences service active", async () => {
  const replaced = await activateRuntime();
  const current = await activateRuntime();

  await replaced.activation.dispose();

  assert.deepEqual(
    await gitPreferences.updateGitPreferences({ autoImportWorktrees: false }),
    { autoImportWorktrees: false },
  );
  await current.activation.dispose();
});

test("generic host project chrome has no direct Git state dependency", () => {
  const files = [
    "../../../../core/frontend/shell/AppShell.tsx",
    "../../../../core/frontend/shell/StandardWorkspaceTabs.tsx",
    "../../../../core/frontend/projects/projectMoveMenu.tsx",
    "../../../../core/frontend/terminal-host/AgentSessionList.tsx",
    "../../../../core/frontend/host/ModuleSessionButton.tsx",
    "../../../../core/frontend/projects/ProjectList.tsx",
    "../../../../core/frontend/shell/StandardWorkspaceNavigation.tsx",
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
  panel.setDiffStripWidth(180);
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
  assert.equal(useGitPanelStore.getState().diffStripWidth, 180);
});

test("diff strip resizing follows a left-edge drag and stays within live layout bounds", () => {
  assert.equal(resizedDiffStripWidth(56, 900, 800, 720), 156);
  assert.equal(resizedDiffStripWidth(156, 800, 1000, 720), 56);
  assert.equal(resizedDiffStripWidth(156, 800, -100, 720), 720);
});
