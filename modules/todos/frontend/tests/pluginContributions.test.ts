import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer, type ViteDevServer } from "vite";

type TodoRuntimeModule = typeof import("../src/pluginContributions.ts");
type TodoPreferencesModule = typeof import("../src/todoPreferences.ts");
type TodoStoreModule = typeof import("../src/store.ts");
type ModuleApi = typeof import("../../../../module-api/frontend/src/index.ts");
type TestingApi = typeof import("../../../../module-api/frontend/src/testing.ts");

let vite: ViteDevServer;
let todoRuntime: TodoRuntimeModule;
let todoPreferences: TodoPreferencesModule;
let todoStore: TodoStoreModule;
let pluginApi: ModuleApi;
let testingApi: TestingApi;

const TODO_ADMISSION = {
  artifact: {
    contentDigest: "0".repeat(64),
    entryUrl: "shipctl://test/todos",
    moduleId: "shipctl.todos" as never,
    version: "0.0.0",
  },
  effectiveGrants: ["plugin-data.read", "plugin-data.write"],
} as const;

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  todoRuntime = await vite.ssrLoadModule(
    "/modules/todos/frontend/src/pluginContributions.ts",
  ) as TodoRuntimeModule;
  todoPreferences = await vite.ssrLoadModule(
    "/modules/todos/frontend/src/todoPreferences.ts",
  ) as TodoPreferencesModule;
  todoStore = await vite.ssrLoadModule(
    "/modules/todos/frontend/src/store.ts",
  ) as TodoStoreModule;
  pluginApi = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ) as ModuleApi;
  testingApi = await vite.ssrLoadModule(
    "/module-api/frontend/src/testing.ts",
  ) as TestingApi;
});

after(async () => {
  await vite.close();
});

beforeEach(() => {
  todoStore.useTodoStore.setState({ projectTodos: {} });
  todoPreferences.configureTodoPreferences(null);
});

async function activateRuntime(options: {
  readonly projectIds?: readonly string[];
  readonly documents?: readonly {
    readonly projectId: string;
    readonly relativePath: string;
    readonly contents: string;
  }[];
  readonly documentsDenied?: boolean;
  readonly projectsUnavailable?: boolean;
  readonly admission?: typeof TODO_ADMISSION;
} = {}) {
  const documentTrace: import("@shipctl/module-api/testing").FakeProjectDocumentsTrace[] = [];
  const changes = new testingApi.FakeProjectsChangeController(options.projectIds ?? []);
  const host = new testingApi.SemanticServiceTestHost([
    testingApi.createFakeProjectDocumentsServiceProvider({
      documents: options.documents,
      deniedOperations: options.documentsDenied ? ["discover"] : [],
      trace: documentTrace,
    }),
    testingApi.createFakeProjectsServiceProvider({
      changes,
      unavailable: options.projectsUnavailable,
    }),
    testingApi.createFakePluginDataServiceProvider(),
  ]);
  const activation = host.activate(
    testingApi.createTestActivationIdentity("shipctl.todos"),
    options.admission ?? TODO_ADMISSION,
  );
  const cleanup = await todoRuntime.activateTodosRuntime(activation.context);
  activation.context.own(cleanup);
  return { activation, changes, documentTrace };
}

test("direct runtime follows generic project catalog changes and releases them on deactivation", async () => {
  const runtime = await activateRuntime({
    projectIds: ["/a"],
    documents: [
      { projectId: "/a", relativePath: "TODO.md", contents: "- [ ] alpha\n" },
      { projectId: "/b", relativePath: "TODO.md", contents: "- [ ] beta\n" },
    ],
  });

  assert.equal(todoStore.useTodoStore.getState().projectTodos["/a"]?.[0]?.items[0]?.text, "alpha");
  assert.equal(runtime.documentTrace.filter(({ operation }) => operation === "discover").length, 1);

  await runtime.changes.setProjects(["/b"]);
  assert.equal(todoStore.useTodoStore.getState().projectTodos["/a"], undefined);
  assert.equal(todoStore.useTodoStore.getState().projectTodos["/b"]?.[0]?.items[0]?.text, "beta");

  await runtime.changes.publishFilesystemChanged(["/b"]);
  assert.equal(runtime.documentTrace.filter(({ operation }) => operation === "discover").length, 3);

  await runtime.activation.dispose();
  assert.equal(todoPreferences.useTodoPreferencesStore.getState().preferences, null);
  const before = todoStore.useTodoStore.getState().projectTodos;
  await runtime.changes.setProjects(["/a"]);
  assert.equal(todoStore.useTodoStore.getState().projectTodos, before);
  await todoRuntime.refreshActiveTodos();
  assert.equal(todoStore.useTodoStore.getState().projectTodos, before);
});

test("unavailable and denied project resources do not leave a stale direct runtime", async () => {
  const unavailable = await activateRuntime({
    projectIds: ["/a"],
    documents: [{ projectId: "/a", relativePath: "TODO.md", contents: "- [ ] alpha\n" }],
    projectsUnavailable: true,
  });
  assert.deepEqual(todoStore.useTodoStore.getState().projectTodos, {});
  assert.deepEqual(unavailable.documentTrace, []);
  await unavailable.activation.dispose();

  const retained = {
    "/a": [],
  };
  todoStore.useTodoStore.setState({ projectTodos: retained });
  const denied = await activateRuntime({
    projectIds: ["/a"],
    documentsDenied: true,
  });
  assert.equal(todoStore.useTodoStore.getState().projectTodos, retained);
  assert.equal(denied.documentTrace[0]?.operation, "discover");
  await denied.activation.dispose();
});

test("preferences use the activation-derived plugin-data namespace and fail closed on a stale revision", async () => {
  const runtime = await activateRuntime();
  const preferences = await todoPreferences.updateTodoPreferences({
    showTodos: false,
    todoFileStyle: "list",
  });
  assert.deepEqual(preferences, { showTodos: false, todoFileStyle: "list" });

  const data = runtime.activation.context.services.require(pluginApi.pluginDataService);
  const revision = todoPreferences.useTodoPreferencesStore.getState().revision;
  assert.ok(revision !== null);
  const external = await data.writeRecord.execute({
    scope: { kind: "global" },
    key: "preferences",
    expectedRevision: revision,
    schemaVersion: 1,
    value: { showTodos: true, todoFileStyle: "kanban" },
  });
  assert.equal(external.result.ok, true);

  await assert.rejects(
    todoPreferences.updateTodoPreferences({ showTodos: true, todoFileStyle: "kanban" }),
    /stale record/,
  );
  assert.deepEqual(todoPreferences.useTodoPreferencesStore.getState().preferences, preferences);
  await runtime.activation.dispose();
});

test("disposing a replaced runtime keeps the current to-do preferences service active", async () => {
  const replaced = await activateRuntime();
  const current = await activateRuntime();

  await replaced.activation.dispose();

  assert.deepEqual(
    await todoPreferences.updateTodoPreferences({ showTodos: false, todoFileStyle: "list" }),
    { showTodos: false, todoFileStyle: "list" },
  );
  await current.activation.dispose();
});
