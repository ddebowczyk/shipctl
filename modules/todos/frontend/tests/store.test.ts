import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ProjectDocumentsService } from "@shipctl/module-api";
import type {
  FakeProjectDocumentSeed,
  FakeProjectDocumentsProviderOptions,
  FakeProjectDocumentsTrace,
} from "@shipctl/module-api/testing";
import { createServer, type ViteDevServer } from "vite";

type TodoStoreModule = typeof import("../src/store.ts");

let vite: ViteDevServer;
let useTodoStore: TodoStoreModule["useTodoStore"];
let createFakeProjectDocumentsServiceProvider: typeof import("@shipctl/module-api/testing")["createFakeProjectDocumentsServiceProvider"];
let createTestActivationIdentity: typeof import("@shipctl/module-api/testing")["createTestActivationIdentity"];
let SemanticServiceTestHost: typeof import("@shipctl/module-api/testing")["SemanticServiceTestHost"];
let projectDocumentsService: typeof import("@shipctl/module-api")["projectDocumentsService"];

function fakeDocuments(
  documents: readonly FakeProjectDocumentSeed[] = [],
  options: Omit<FakeProjectDocumentsProviderOptions, "documents"> = {},
): ProjectDocumentsService {
  const host = new SemanticServiceTestHost([
    createFakeProjectDocumentsServiceProvider({ ...options, documents }),
  ]);
  return host.activate(
    createTestActivationIdentity("shipctl.todos"),
  ).context.services.require(projectDocumentsService);
}

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({ useTodoStore } = await vite.ssrLoadModule(
    "/modules/todos/frontend/src/store.ts",
  ) as TodoStoreModule);
  ({ projectDocumentsService } = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ));
  ({
    createFakeProjectDocumentsServiceProvider,
    createTestActivationIdentity,
    SemanticServiceTestHost,
  } = await vite.ssrLoadModule("/module-api/frontend/src/testing.ts"));
});

after(async () => {
  await vite.close();
});

beforeEach(() => {
  useTodoStore.setState({ projectTodos: {} });
});

test("refresh discovers project-relative documents and keeps failed caches", async () => {
  const documents = fakeDocuments([
    { projectId: "/a", relativePath: "TODO.md", contents: "- [ ] alpha\n" },
  ]);
  await useTodoStore.getState().refreshAll(documents, ["/a", "/b"]);
  assert.equal(useTodoStore.getState().projectTodos["/a"][0].relativePath, "TODO.md");
  assert.equal(useTodoStore.getState().projectTodos["/a"][0].items[0].text, "alpha");

  const previous = useTodoStore.getState().projectTodos;
  const denied = fakeDocuments([], { deniedOperations: ["discover"] });
  await useTodoStore.getState().refreshAll(denied, ["/a"]);
  assert.equal(useTodoStore.getState().projectTodos, previous);
});

test("toggle compares the rendered revision and refreshes the cache", async () => {
  const trace: FakeProjectDocumentsTrace[] = [];
  const documents = fakeDocuments([
    { projectId: "/repo", relativePath: "TODO.md", contents: "- [ ] task\n" },
  ], { trace });
  await useTodoStore.getState().refreshTodos(documents, "/repo");
  const file = useTodoStore.getState().projectTodos["/repo"][0];
  await useTodoStore.getState().toggleItem(documents, file, 0, "task", true);

  const write = trace.find((entry) => entry.operation === "write");
  assert.deepEqual(write?.request.input, {
    projectId: "/repo",
    relativePath: "TODO.md",
    expectedRevision: file.revision,
    contents: "- [x] task\n",
  });
  assert.equal(useTodoStore.getState().projectTodos["/repo"][0].items[0].checked, true);
});

test("a stale revision fails closed and refreshes external contents", async () => {
  const documents = fakeDocuments([
    { projectId: "/repo", relativePath: "TODO.md", contents: "- [ ] task\n" },
  ]);
  await useTodoStore.getState().refreshTodos(documents, "/repo");
  const stale = useTodoStore.getState().projectTodos["/repo"][0];
  const external = await documents.writeDocument.execute({
    projectId: "/repo",
    relativePath: "TODO.md",
    expectedRevision: stale.revision,
    contents: "- [ ] external\n",
  });
  assert.equal(external.result.ok, true);

  await assert.rejects(
    useTodoStore.getState().toggleItem(documents, stale, 0, "task", true),
    /revision does not match/,
  );
  assert.equal(useTodoStore.getState().projectTodos["/repo"][0].items[0].text, "external");
});

test("a stale add fails closed and refreshes external contents", async () => {
  const documents = fakeDocuments([
    { projectId: "/repo", relativePath: "TODO.md", contents: "- [ ] task\n" },
  ]);
  await useTodoStore.getState().refreshTodos(documents, "/repo");
  const stale = useTodoStore.getState().projectTodos["/repo"][0];
  const external = await documents.writeDocument.execute({
    projectId: "/repo",
    relativePath: "TODO.md",
    expectedRevision: stale.revision,
    contents: "- [ ] external\n",
  });
  assert.equal(external.result.ok, true);

  await assert.rejects(
    useTodoStore.getState().addItem(documents, "/repo", stale, "local", null, false),
    /revision does not match/,
  );
  assert.equal(useTodoStore.getState().projectTodos["/repo"][0].items[0].text, "external");
});

test("add creates TODO.md and move publishes transformed contents", async () => {
  const documents = fakeDocuments();
  await useTodoStore.getState().addItem(documents, "/repo", null, "first", null, true);
  const created = useTodoStore.getState().projectTodos["/repo"][0];
  assert.equal(created.relativePath, "TODO.md");
  assert.equal(created.items[0].text, "first");

  await useTodoStore.getState().moveItem(
    documents,
    created,
    created.items[0].line,
    "first",
    created.sections.at(-1)!.line,
    true,
  );
  assert.equal(useTodoStore.getState().projectTodos["/repo"][0].items[0].checked, true);
});

test("removing a project evicts only its render cache", async () => {
  const documents = fakeDocuments([
    { projectId: "/a", relativePath: "TODO.md", contents: "- [ ] a\n" },
    { projectId: "/b", relativePath: "TODO.md", contents: "- [ ] b\n" },
  ]);
  await useTodoStore.getState().refreshAll(documents, ["/a", "/b"]);
  useTodoStore.getState().removeProject("/a");
  assert.deepEqual(Object.keys(useTodoStore.getState().projectTodos), ["/b"]);
});
