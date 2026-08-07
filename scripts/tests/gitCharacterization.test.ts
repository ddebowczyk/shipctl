import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer, type Plugin, type ViteDevServer } from "vite";

import type { GitStatus } from "../../src/lib/types.ts";

type GitStoreModule = typeof import("../../src/stores/useGitStore.ts");
type GitPanelStoreModule = typeof import("../../src/stores/useGitPanelStore.ts");

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
    if (source === "../lib/tauri" && importer?.endsWith("/src/stores/useGitStore.ts")) {
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

let vite: ViteDevServer;
let useGitStore: GitStoreModule["useGitStore"];
let useGitPanelStore: GitPanelStoreModule["useGitPanelStore"];
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
    "/src/stores/useGitStore.ts",
  ) as GitStoreModule);
  ({ useGitPanelStore } = await vite.ssrLoadModule(
    "/src/stores/useGitPanelStore.ts",
  ) as GitPanelStoreModule);
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
