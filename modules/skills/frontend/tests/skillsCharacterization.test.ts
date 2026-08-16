import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer, type ViteDevServer } from "vite";

import type {
  ModuleActivationContext,
  ModuleHostServices,
  SkillInspection,
} from "@shipctl/module-api";
import type {
  FakeSkillCatalogSeed,
  FakeSkillInstallationOperation,
  FakeSkillInstallationTrace,
} from "@shipctl/module-api/testing";
import type { SkillInfo } from "../src/types.ts";

type SkillStoreModule = typeof import("../src/store.ts");
type SkillsEntryModule = typeof import("../src/index.ts");
type SkillClientModule = typeof import("../src/skillInstallationClient.ts");
type ModuleApi = typeof import("@shipctl/module-api");
type ModuleApiTesting = typeof import("@shipctl/module-api/testing");

let vite: ViteDevServer;
let useSkillStore: SkillStoreModule["useSkillStore"];
let skillsModule: SkillsEntryModule["skillsModule"];
let skillInstallationClientFor: SkillClientModule["skillInstallationClientFor"];
let skillId: ModuleApi["skillId"];
let createFakeSkillInstallationServiceProvider:
  ModuleApiTesting["createFakeSkillInstallationServiceProvider"];
let createTestActivationIdentity: ModuleApiTesting["createTestActivationIdentity"];
let SemanticServiceTestHost: ModuleApiTesting["SemanticServiceTestHost"];
let cleanups: Array<() => void | Promise<void>> = [];

function catalog(installedName?: string): SkillInfo[] {
  return [
    {
      name: "shipctl-todos",
      title: "Project to-dos",
      description: "Synthetic to-dos fixture",
      installed: installedName === "shipctl-todos",
    },
    {
      name: "orchestrate",
      title: "Orchestrate",
      description: "Synthetic orchestrator fixture",
      installed: installedName === "orchestrate",
    },
  ];
}

function semanticCatalog(installedName?: string): readonly SkillInspection[] {
  return catalog(installedName).map((skill) => ({
    skillId: skillId(skill.name),
    title: skill.title,
    description: skill.description,
    installed: skill.installed,
  }));
}

function activateSkills(
  projects: readonly FakeSkillCatalogSeed[],
  deniedOperations: readonly FakeSkillInstallationOperation[] = [],
  trace: FakeSkillInstallationTrace[] = [],
): ModuleActivationContext {
  const host = new SemanticServiceTestHost([
    createFakeSkillInstallationServiceProvider({ projects, deniedOperations, trace }),
  ]);
  const activation = host.activate(createTestActivationIdentity("shipctl.skills"));
  cleanups.push(() => activation.dispose());
  return activation.context;
}

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({ useSkillStore } = await vite.ssrLoadModule(
    "/modules/skills/frontend/src/store.ts",
  ) as SkillStoreModule);
  ({ skillsModule } = await vite.ssrLoadModule(
    "/modules/skills/frontend/src/index.ts",
  ) as SkillsEntryModule);
  ({ skillInstallationClientFor } = await vite.ssrLoadModule(
    "/modules/skills/frontend/src/skillInstallationClient.ts",
  ) as SkillClientModule);
  ({ skillId } = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ) as ModuleApi);
  ({
    createFakeSkillInstallationServiceProvider,
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
  cleanups = [];
  useSkillStore.setState({ skillsByRepo: {} });
});

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

function services(
  notices: Array<{ tone: string; title: string; message?: string }> = [],
): ModuleHostServices {
  return {
    panels: {
      open: () => "fixture-panel",
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
      getSnapshot: () => ({ values: {}, isSaving: false, error: null }),
      subscribe: () => () => undefined,
      update: async () => undefined,
    },
    skills: skillsModule.skillsProvider.port,
    notices: { push: (notice) => notices.push(notice) },
    externalLinks: { open: async () => undefined },
  };
}

test("Skills module source depends on its semantic contract and not on Tauri", () => {
  const sourceDirectory = fileURLToPath(new URL("../src", import.meta.url));
  const source = readdirSync(sourceDirectory, { recursive: true })
    .filter((entry) => typeof entry === "string" && /\.(?:ts|tsx)$/u.test(entry))
    .map((entry) => readFileSync(`${sourceDirectory}/${entry}`, "utf8"))
    .join("\n");

  assert.match(source, /skillInstallationService/);
  assert.doesNotMatch(source, /@tauri-apps\/api|plugin:shipctl-skills\|/);
});

test("refreshAll keeps successful project snapshots and preserves failed caches", async () => {
  const oldBeta = catalog("orchestrate");
  useSkillStore.setState({ skillsByRepo: { "/beta": oldBeta } });
  const activation = activateSkills([
    { projectId: "/alpha", skills: semanticCatalog("shipctl-todos") },
  ]);

  await useSkillStore.getState().refreshAll(
    ["/alpha", "/beta"],
    skillInstallationClientFor(activation),
  );

  assert.deepEqual(useSkillStore.getState().skillsByRepo, {
    "/alpha": catalog("shipctl-todos"),
    "/beta": oldBeta,
  });
});

test("install and uninstall mutate first, then refresh the target project", async () => {
  const trace: FakeSkillInstallationTrace[] = [];
  const activation = activateSkills(
    [{ projectId: "/repo", skills: semanticCatalog() }],
    [],
    trace,
  );
  const client = skillInstallationClientFor(activation);

  await useSkillStore.getState().install("/repo", "shipctl-todos", client);
  assert.equal(useSkillStore.getState().skillsByRepo["/repo"][0].installed, true);
  await useSkillStore.getState().uninstall("/repo", "shipctl-todos", client);
  assert.equal(useSkillStore.getState().skillsByRepo["/repo"][0].installed, false);

  assert.deepEqual(trace.map(({ operation }) => operation), [
    "install-skill",
    "inspect-skills",
    "remove-skill",
    "inspect-skills",
  ]);
});

test("mutation errors reject without refreshing or changing cached state", async () => {
  const cached = catalog();
  const trace: FakeSkillInstallationTrace[] = [];
  useSkillStore.setState({ skillsByRepo: { "/repo": cached } });
  const activation = activateSkills(
    [{ projectId: "/repo", skills: semanticCatalog() }],
    ["install-skill"],
    trace,
  );

  await assert.rejects(
    useSkillStore.getState().install(
      "/repo",
      "shipctl-todos",
      skillInstallationClientFor(activation),
    ),
    /denied/,
  );

  assert.deepEqual(trace.map(({ operation }) => operation), ["install-skill"]);
  assert.equal(useSkillStore.getState().skillsByRepo["/repo"], cached);
});

test("removing a project evicts only its process-local render cache", () => {
  const alpha = catalog("shipctl-todos");
  const beta = catalog("orchestrate");
  useSkillStore.setState({ skillsByRepo: { "/alpha": alpha, "/beta": beta } });

  useSkillStore.getState().removeProject("/alpha");

  assert.deepEqual(useSkillStore.getState().skillsByRepo, { "/beta": beta });
});

test("module contributions use the exact activation and contain operation errors", async () => {
  const repoSkills = catalog();
  const trace: FakeSkillInstallationTrace[] = [];
  const notices: Array<{ tone: string; title: string; message?: string }> = [];
  useSkillStore.setState({ skillsByRepo: { "/repo": repoSkills } });
  const activation = activateSkills(
    [{ projectId: "/repo", skills: semanticCatalog() }],
    ["install-skill"],
    trace,
  );
  const moduleDeactivation = skillsModule.activate({ activation } as never);
  if (moduleDeactivation) cleanups.push(() => moduleDeactivation.deactivate());

  assert.equal(skillsModule.id, "shipctl.skills");
  assert.equal(skillsModule.skillsProvider.id, "skills.provider");
  assert.equal(skillsModule.projectActions[0].id, "skills.project-actions");
  assert.equal(
    skillsModule.skillsProvider.port.getSnapshot().byProject["/repo"],
    repoSkills,
  );

  const group = skillsModule.projectActions[0].getGroup(
    { id: "repo", name: "Repo", path: "/repo" },
    services(notices),
    activation,
  );
  assert.equal(group?.label, "Agent Skills");
  assert.equal(group?.actions[0].selected, false);
  await group?.actions[0].run();

  assert.deepEqual(trace.map(({ operation }) => operation), ["install-skill"]);
  assert.deepEqual(notices, [{
    tone: "error",
    title: "Couldn't add agent skill",
    message: "Fake skill operation denied: install-skill",
  }]);
});

test("module lifecycle and provider port resolve the activation-owned client", async () => {
  const trace: FakeSkillInstallationTrace[] = [];
  const activation = activateSkills(
    [{ projectId: "/repo", skills: semanticCatalog() }],
    [],
    trace,
  );
  const moduleDeactivation = skillsModule.activate({ activation } as never);
  if (moduleDeactivation) cleanups.push(() => moduleDeactivation.deactivate());

  await skillsModule.projectLifecycle.onProjectsChanged(
    ["/repo"],
    services(),
    activation,
  );
  await skillsModule.skillsProvider.port.install("/repo", "shipctl-todos");

  assert.equal(
    skillsModule.skillsProvider.port.getSnapshot().byProject["/repo"][0].installed,
    true,
  );
  assert.deepEqual(trace.map(({ operation }) => operation), [
    "inspect-skills",
    "install-skill",
    "inspect-skills",
  ]);
});
