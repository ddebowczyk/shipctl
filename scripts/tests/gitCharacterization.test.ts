import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer, type Plugin, type ViteDevServer } from "vite";

import type { GitStatus } from "../../modules/git/frontend/src/types.ts";

type GitStoreModule = typeof import("../../modules/git/frontend/src/store.ts");
type GitPanelStoreModule = typeof import("../../modules/git/frontend/src/panelStore.ts");
type GitFrontendModule = typeof import("../../modules/git/frontend/src/index.ts");

interface NativeMock {
  gitStatus(repoPath: string): Promise<GitStatus>;
}

const virtualNativeId = "\0git-native-characterization";
const nativeGlobal = globalThis as typeof globalThis & {
  __shepGitNativeMock: NativeMock;
};

const nativePlugin: Plugin = {
  name: "git-native-characterization",
  enforce: "pre",
  resolveId(source, importer) {
    if (source === "./client" && importer?.endsWith("/modules/git/frontend/src/store.ts")) {
      return virtualNativeId;
    }
    return null;
  },
  load(id) {
    if (id !== virtualNativeId) return null;
    return `
      const native = () => globalThis.__shepGitNativeMock;
      export const gitStatus = (...args) => native().gitStatus(...args);
    `;
  },
};

test("frontend Git calls use the namespaced plugin command surface", () => {
  const gitClient = readFileSync(
    fileURLToPath(new URL("../../modules/git/frontend/src/client.ts", import.meta.url)),
    "utf8",
  );
  const commands = [
    "is_git_repo",
    "git_init",
    "git_current_branch",
    "git_list_branches",
    "git_list_worktrees",
    "git_create_worktree",
    "git_status",
    "git_changed_files",
    "git_file_diff",
    "git_file_contents",
    "git_list_files",
    "git_switch_branch",
    "git_create_branch",
    "git_diff_stats",
  ];

  for (const command of commands) {
    assert.match(gitClient, new RegExp(`plugin:shep-git\\|${command}`));
    assert.doesNotMatch(
      gitClient,
      new RegExp(`invoke(?:<[^>]+>)?\\(\\s*[\"']${command}[\"']`),
    );
  }
});

let vite: ViteDevServer;
let useGitStore: GitStoreModule["useGitStore"];
let useGitPanelStore: GitPanelStoreModule["useGitPanelStore"];
let gitModule: GitFrontendModule["gitModule"];
let implementations: Map<string, () => Promise<GitStatus>>;

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    is_git_repo: true,
    branch: "main",
    dirty: false,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
    worktree_parent: null,
    ...overrides,
  };
}

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    plugins: [nativePlugin],
    root: fileURLToPath(new URL("../..", import.meta.url)),
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
});

after(async () => {
  await vite.close();
  delete (globalThis as Partial<typeof nativeGlobal>).__shepGitNativeMock;
});

beforeEach(() => {
  implementations = new Map();
  nativeGlobal.__shepGitNativeMock = {
    gitStatus(repoPath) {
      return (implementations.get(repoPath) ?? (async () => status()))();
    },
  };
  useGitStore.setState({ projectGitStatus: {} });
  useGitPanelStore.setState({ perRepo: {} });
});

test("batch refresh updates fulfilled projects and preserves failed project snapshots", async () => {
  const oldBeta = status({ branch: "beta-old", dirty: true });
  useGitStore.setState({
    projectGitStatus: {
      "/alpha": status({ branch: "alpha-old" }),
      "/beta": oldBeta,
    },
  });
  implementations.set("/alpha", async () => status({ branch: "alpha-new", ahead: 2 }));
  implementations.set("/beta", async () => {
    throw new Error("git unavailable");
  });

  await useGitStore.getState().refreshAll(["/alpha", "/beta"]);

  assert.deepEqual(useGitStore.getState().projectGitStatus, {
    "/alpha": status({ branch: "alpha-new", ahead: 2 }),
    "/beta": oldBeta,
  });
});

test("single refresh failures are silent and equal snapshots retain store identity", async () => {
  const original = status({ branch: "main", untracked: 1 });
  useGitStore.setState({ projectGitStatus: { "/repo": original } });
  implementations.set("/repo", async () => {
    throw new Error("temporary failure");
  });

  await useGitStore.getState().refreshStatus("/repo");
  assert.equal(useGitStore.getState().projectGitStatus["/repo"], original);

  implementations.set("/repo", async () => ({ ...original }));
  const beforeState = useGitStore.getState();
  await useGitStore.getState().refreshAll(["/repo"]);
  assert.equal(useGitStore.getState(), beforeState);
});

test("project removal evicts only the requested Git status snapshot", () => {
  const alpha = status({ branch: "alpha" });
  const beta = status({ branch: "beta" });
  useGitStore.setState({ projectGitStatus: { "/alpha": alpha, "/beta": beta } });

  useGitStore.getState().removeProject("/alpha");

  assert.deepEqual(useGitStore.getState().projectGitStatus, { "/beta": beta });
});

test("module lifecycle owns project refresh, filesystem refresh, and removal", async () => {
  implementations.set("/alpha", async () => status({ branch: "alpha" }));
  implementations.set("/beta", async () => status({ branch: "beta", dirty: true }));

  await gitModule.projectLifecycle.onProjectsChanged(["/alpha"]);
  await gitModule.projectLifecycle.onFilesystemChanged(["/beta"]);
  assert.equal(useGitStore.getState().projectGitStatus["/alpha"].branch, "alpha");
  assert.equal(useGitStore.getState().projectGitStatus["/beta"].dirty, true);

  gitModule.projectLifecycle.onProjectRemoved("/alpha");
  assert.equal(useGitStore.getState().projectGitStatus["/alpha"], undefined);
  assert.equal(useGitStore.getState().projectGitStatus["/beta"].branch, "beta");
});

test("generic host project chrome has no direct Git state dependency", () => {
  const files = [
    "../../src/components/layout/AppShell.tsx",
    "../../src/components/layout/TabBar.tsx",
    "../../src/components/shared/projectMoveMenu.tsx",
    "../../src/components/sidebar/AgentSessionList.tsx",
    "../../src/components/sidebar/AssistantButton.tsx",
    "../../src/components/sidebar/ProjectList.tsx",
    "../../src/components/sidebar/Sidebar.tsx",
    "../../src/components/sidebar/TerminalItem.tsx",
    "../../src/hooks/useGitWatcher.ts",
    "../../src/lib/projectGrouping.ts",
  ];

  for (const file of files) {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    assert.doesNotMatch(source, /useGitStore|projectGitStatus|worktree_parent/);
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
