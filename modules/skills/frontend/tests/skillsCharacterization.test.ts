import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer, type Plugin, type ViteDevServer } from "vite";

import type { ModuleHostServices } from "@shep/module-api";
import { SKILL_COMMANDS } from "../src/client.ts";
import type { SkillInfo } from "../src/types.ts";

type SkillStoreModule = typeof import("../src/store.ts");
type SkillsEntryModule = typeof import("../src/index.ts");

interface NativeMock {
  listSkills(repoPath: string): Promise<SkillInfo[]>;
  setupSkill(repoPath: string, name: string): Promise<void>;
  removeSkill(repoPath: string, name: string): Promise<void>;
}

const virtualNativeId = "\0skills-native-characterization";
const nativeGlobal = globalThis as typeof globalThis & {
  __shepSkillsNativeMock: NativeMock;
};

const nativePlugin: Plugin = {
  name: "skills-native-characterization",
  enforce: "pre",
  resolveId(source, importer) {
    if (source === "./client" && importer?.endsWith("/modules/skills/frontend/src/store.ts")) {
      return virtualNativeId;
    }
    return null;
  },
  load(id) {
    if (id !== virtualNativeId) return null;
    return `
      const native = () => globalThis.__shepSkillsNativeMock;
      export const listSkills = (...args) => native().listSkills(...args);
      export const setupSkill = (...args) => native().setupSkill(...args);
      export const removeSkill = (...args) => native().removeSkill(...args);
    `;
  },
};

let vite: ViteDevServer;
let useSkillStore: SkillStoreModule["useSkillStore"];
let skillsModule: SkillsEntryModule["skillsModule"];
let calls: Array<{ operation: string; args: string[] }>;
let listImplementations: Map<string, () => Promise<SkillInfo[]>>;
let setupError: Error | null;
let removeError: Error | null;

function catalog(installedName?: string): SkillInfo[] {
  return [
    {
      name: "shep-todos",
      title: "Project to-dos",
      description: "Synthetic to-dos fixture",
      installed: installedName === "shep-todos",
    },
    {
      name: "orchestrate",
      title: "Orchestrate",
      description: "Synthetic orchestrator fixture",
      installed: installedName === "orchestrate",
    },
  ];
}

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    plugins: [nativePlugin],
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({ useSkillStore } = await vite.ssrLoadModule(
    "/modules/skills/frontend/src/store.ts",
  ) as SkillStoreModule);
  ({ skillsModule } = await vite.ssrLoadModule(
    "/modules/skills/frontend/src/index.ts",
  ) as SkillsEntryModule);
});

after(async () => {
  await vite.close();
  delete (globalThis as Partial<typeof nativeGlobal>).__shepSkillsNativeMock;
});

beforeEach(() => {
  calls = [];
  listImplementations = new Map();
  setupError = null;
  removeError = null;
  nativeGlobal.__shepSkillsNativeMock = {
    async listSkills(repoPath) {
      calls.push({ operation: "listSkills", args: [repoPath] });
      return (listImplementations.get(repoPath) ?? (async () => []))();
    },
    async setupSkill(repoPath, name) {
      calls.push({ operation: "setupSkill", args: [repoPath, name] });
      if (setupError) throw setupError;
    },
    async removeSkill(repoPath, name) {
      calls.push({ operation: "removeSkill", args: [repoPath, name] });
      if (removeError) throw removeError;
    },
  };
  useSkillStore.setState({ skillsByRepo: {} });
});

test("refreshAll keeps independent project snapshots, including an empty catalog", async () => {
  const alpha = catalog("shep-todos");
  listImplementations.set("/alpha", async () => alpha);
  listImplementations.set("/beta", async () => []);

  await useSkillStore.getState().refreshAll(["/alpha", "/beta"]);

  assert.deepEqual(useSkillStore.getState().skillsByRepo, {
    "/alpha": alpha,
    "/beta": [],
  });
});

test("failed refreshes leave the last successful project cache untouched", async () => {
  const oldAlpha = catalog();
  const oldBeta = catalog("orchestrate");
  const nextAlpha = catalog("shep-todos");
  useSkillStore.setState({
    skillsByRepo: { "/alpha": oldAlpha, "/beta": oldBeta },
  });
  listImplementations.set("/alpha", async () => nextAlpha);
  listImplementations.set("/beta", async () => {
    throw new Error("project unavailable");
  });

  await useSkillStore.getState().refreshAll(["/alpha", "/beta"]);
  await useSkillStore.getState().refresh("/beta");

  assert.deepEqual(useSkillStore.getState().skillsByRepo, {
    "/alpha": nextAlpha,
    "/beta": oldBeta,
  });
});

test("install and uninstall mutate first, then refresh the target project", async () => {
  let installed = false;
  listImplementations.set("/repo", async () => catalog(installed ? "shep-todos" : undefined));
  nativeGlobal.__shepSkillsNativeMock.setupSkill = async (repoPath, name) => {
    calls.push({ operation: "setupSkill", args: [repoPath, name] });
    installed = true;
  };
  nativeGlobal.__shepSkillsNativeMock.removeSkill = async (repoPath, name) => {
    calls.push({ operation: "removeSkill", args: [repoPath, name] });
    installed = false;
  };

  await useSkillStore.getState().install("/repo", "shep-todos");
  assert.equal(useSkillStore.getState().skillsByRepo["/repo"][0].installed, true);
  await useSkillStore.getState().uninstall("/repo", "shep-todos");
  assert.equal(useSkillStore.getState().skillsByRepo["/repo"][0].installed, false);

  assert.deepEqual(calls, [
    { operation: "setupSkill", args: ["/repo", "shep-todos"] },
    { operation: "listSkills", args: ["/repo"] },
    { operation: "removeSkill", args: ["/repo", "shep-todos"] },
    { operation: "listSkills", args: ["/repo"] },
  ]);
});

test("mutation errors reject without refreshing or changing cached state", async () => {
  const cached = catalog();
  useSkillStore.setState({ skillsByRepo: { "/repo": cached } });
  setupError = new Error("write denied");

  await assert.rejects(
    useSkillStore.getState().install("/repo", "shep-todos"),
    /write denied/,
  );

  assert.deepEqual(calls, [
    { operation: "setupSkill", args: ["/repo", "shep-todos"] },
  ]);
  assert.equal(useSkillStore.getState().skillsByRepo["/repo"], cached);
});

test("removing a project evicts only its process-local render cache", () => {
  const alpha = catalog("shep-todos");
  const beta = catalog("orchestrate");
  useSkillStore.setState({ skillsByRepo: { "/alpha": alpha, "/beta": beta } });

  useSkillStore.getState().removeProject("/alpha");

  assert.deepEqual(useSkillStore.getState().skillsByRepo, { "/beta": beta });
});

test("module entry owns the provider, project action, and error notice", async () => {
  const repoSkills = catalog();
  useSkillStore.setState({ skillsByRepo: { "/repo": repoSkills } });
  setupError = new Error("write denied");
  const notices: Array<{ tone: string; title: string; message?: string }> = [];
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
      getSnapshot: () => ({ values: {}, isSaving: false, error: null }),
      subscribe: () => () => undefined,
      update: async () => undefined,
    },
    skills: skillsModule.skillsProvider.port,
    notices: { push: (notice) => notices.push(notice) },
    externalLinks: { open: async () => undefined },
  } satisfies ModuleHostServices;

  assert.equal(skillsModule.id, "shep.skills");
  assert.equal(skillsModule.skillsProvider.id, "skills.provider");
  assert.equal(skillsModule.projectActions[0].id, "skills.project-actions");
  assert.equal(
    skillsModule.skillsProvider.port.getSnapshot().byProject["/repo"],
    repoSkills,
  );

  const group = skillsModule.projectActions[0].getGroup(
    { id: "repo", name: "Repo", path: "/repo" },
    services,
  );
  assert.equal(group?.label, "Agent Skills");
  assert.equal(group?.actions[0].selected, false);
  await group?.actions[0].run();

  assert.deepEqual(calls, [
    { operation: "setupSkill", args: ["/repo", "shep-todos"] },
  ]);
  assert.deepEqual(notices, [
    {
      tone: "error",
      title: "Couldn't add agent skill",
      message: "write denied",
    },
  ]);
});

test("native client uses only namespaced Skills plugin commands", () => {
  assert.deepEqual(SKILL_COMMANDS, {
    list: "plugin:shep-skills|list_skills",
    setup: "plugin:shep-skills|setup_skill",
    remove: "plugin:shep-skills|remove_skill",
  });
});
