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
type SkillsRuntimeModule = typeof import("../src/pluginContributions.ts");
type SkillClientModule = typeof import("../src/skillInstallationClient.ts");
type ModuleApi = typeof import("@shipctl/module-api");
type ModuleApiTesting = typeof import("@shipctl/module-api/testing");

let vite: ViteDevServer;
let useSkillStore: SkillStoreModule["useSkillStore"];
let skillsRuntime: SkillsRuntimeModule;
let skillInstallationClientFor: SkillClientModule["skillInstallationClientFor"];
let skillId: ModuleApi["skillId"];
let testingApi: ModuleApiTesting;
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
      description: "Teaches agents to keep TODO.md as a kanban board: move cards when starting or finishing work, add discovered work to the backlog, and reconcile the board before ending a session.",
      installed: installedName === "shipctl-todos",
    },
    {
      name: "orchestrate",
      title: "Orchestrate",
      description: "Turns any agent into a planner/orchestrator that delegates implementation to a different agent CLI running headless (codex, claude, opencode), reviews each task, and finishes with a fresh-context audit.",
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

async function activateRuntime(options: {
  readonly projectIds?: readonly string[];
  readonly projects?: Parameters<
    ModuleApiTesting["createFakeSkillInstallationServiceProvider"]
  >[0]["projects"];
  readonly deniedOperations?: readonly FakeSkillInstallationOperation[];
  readonly projectsUnavailable?: boolean;
  readonly changes?: InstanceType<ModuleApiTesting["FakeProjectsChangeController"]>;
  readonly trace?: FakeSkillInstallationTrace[];
} = {}) {
  const changes = options.changes ?? new testingApi.FakeProjectsChangeController(
    options.projectIds ?? [],
  );
  const host = new SemanticServiceTestHost([
    createFakeSkillInstallationServiceProvider({
      projects: options.projects,
      deniedOperations: options.deniedOperations,
      trace: options.trace,
    }),
    testingApi.createFakeProjectsServiceProvider({
      changes,
      unavailable: options.projectsUnavailable,
    }),
  ]);
  const activation = host.activate(createTestActivationIdentity("shipctl.skills"));
  const cleanup = await skillsRuntime.activateSkillsRuntime(activation.context);
  activation.context.own(cleanup);
  cleanups.push(() => activation.dispose());
  return { activation, changes };
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
  skillsRuntime = await vite.ssrLoadModule(
    "/modules/skills/frontend/src/pluginContributions.ts",
  ) as SkillsRuntimeModule;
  ({ skillInstallationClientFor } = await vite.ssrLoadModule(
    "/modules/skills/frontend/src/skillInstallationClient.ts",
  ) as SkillClientModule);
  ({ skillId } = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ) as ModuleApi);
  testingApi = await vite.ssrLoadModule(
    "/module-api/frontend/src/testing.ts",
  ) as ModuleApiTesting;
  ({
    createFakeSkillInstallationServiceProvider,
    createTestActivationIdentity,
    SemanticServiceTestHost,
  } = testingApi);
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
    skills: skillsRuntime.skillsContributions.skillsProviders[0].port,
    notices: { push: (notice) => notices.push(notice) },
    externalLinks: { open: async () => undefined },
  };
}

test("Skills direct runtime depends on semantic contracts and not on Tauri", () => {
  const sourceDirectory = fileURLToPath(new URL("../src", import.meta.url));
  const source = readdirSync(sourceDirectory, { recursive: true })
    .filter((entry) => typeof entry === "string" && /\.(?:ts|tsx)$/u.test(entry))
    .map((entry) => readFileSync(`${sourceDirectory}/${entry}`, "utf8"))
    .join("\n");

  assert.match(source, /skillInstallationService/);
  assert.match(source, /projectsService/);
  assert.doesNotMatch(source, /\bskillsModule\b/);
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

test("direct contributions use the exact activation and contain operation errors", async () => {
  const repoSkills = catalog();
  const trace: FakeSkillInstallationTrace[] = [];
  const notices: Array<{ tone: string; title: string; message?: string }> = [];
  useSkillStore.setState({ skillsByRepo: { "/repo": repoSkills } });
  const runtime = await activateRuntime({
    projectIds: ["/repo"],
    projects: [{ projectId: "/repo", skills: semanticCatalog() }],
    deniedOperations: ["install-skill"],
    trace,
  });
  const provider = skillsRuntime.skillsContributions.skillsProviders[0];
  const projectActions = skillsRuntime.skillsContributions.projectActions;

  assert.equal(skillsRuntime.SKILLS_MODULE_ID, "shipctl.skills");
  assert.equal(provider.id, "skills.provider");
  assert.equal(projectActions[0].id, "skills.project-actions");
  assert.deepEqual(provider.port.getSnapshot().byProject["/repo"], repoSkills);

  const group = projectActions[0].getGroup(
    { id: "repo", name: "Repo", path: "/repo" },
    services(notices),
    runtime.activation.context,
  );
  assert.equal(group?.label, "Agent Skills");
  assert.equal(group?.actions[0].selected, false);
  const traceBeforeAction = trace.length;
  await group?.actions[0].run();

  assert.deepEqual(trace.slice(traceBeforeAction).map(({ operation }) => operation), [
    "install-skill",
  ]);
  assert.deepEqual(notices, [{
    tone: "error",
    title: "Couldn't add agent skill",
    message: "Fake skill operation denied: install-skill",
  }]);
});

test("direct runtime owns catalog lifecycle and provider activity", async () => {
  const trace: FakeSkillInstallationTrace[] = [];
  const runtime = await activateRuntime({
    projectIds: ["/repo"],
    projects: [{ projectId: "/repo", skills: semanticCatalog() }],
    trace,
  });
  const provider = skillsRuntime.skillsContributions.skillsProviders[0];

  await runtime.changes.publishFilesystemChanged(["/repo"]);
  await provider.port.install("/repo", "shipctl-todos");

  assert.equal(
    provider.port.getSnapshot().byProject["/repo"][0].installed,
    true,
  );
  assert.deepEqual(trace.map(({ operation }) => operation), [
    "inspect-skills",
    "inspect-skills",
    "install-skill",
    "inspect-skills",
  ]);

  await runtime.changes.setProjects([]);
  assert.deepEqual(provider.port.getSnapshot().byProject, {});
  await runtime.activation.dispose();
  await assert.rejects(
    provider.port.install("/repo", "shipctl-todos"),
    /Skills module is not active/,
  );
});

test("repeated direct activation does not retain Skills catalog listeners", async () => {
  const changes = new testingApi.FakeProjectsChangeController(["/repo"]);
  const firstTrace: FakeSkillInstallationTrace[] = [];
  const first = await activateRuntime({
    changes,
    projects: [{ projectId: "/repo", skills: semanticCatalog() }],
    trace: firstTrace,
  });
  await changes.publishFilesystemChanged(["/repo"]);
  assert.equal(firstTrace.filter(({ operation }) => operation === "inspect-skills").length, 2);
  await first.activation.dispose();
  const beforeDetached = firstTrace.length;
  await changes.publishFilesystemChanged(["/repo"]);
  assert.equal(firstTrace.length, beforeDetached);

  const secondTrace: FakeSkillInstallationTrace[] = [];
  await activateRuntime({
    changes,
    projects: [{ projectId: "/repo", skills: semanticCatalog("orchestrate") }],
    trace: secondTrace,
  });
  await changes.publishFilesystemChanged(["/repo"]);
  assert.equal(secondTrace.filter(({ operation }) => operation === "inspect-skills").length, 2);
  assert.equal(
    skillsRuntime.skillsContributions.skillsProviders[0].port
      .getSnapshot().byProject["/repo"][1].installed,
    true,
  );
});

test("an unavailable project catalog leaves the Skills cache unchanged", async () => {
  const retained = catalog("orchestrate");
  const trace: FakeSkillInstallationTrace[] = [];
  useSkillStore.setState({ skillsByRepo: { "/retained": retained } });

  await activateRuntime({ projectsUnavailable: true, trace });

  assert.equal(useSkillStore.getState().skillsByRepo["/retained"], retained);
  assert.deepEqual(trace, []);
});
