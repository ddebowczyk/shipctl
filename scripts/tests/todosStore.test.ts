import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer, type Plugin, type ViteDevServer } from "vite";

import type { TodoFile } from "../../modules/todos/frontend/src/types.ts";

type TodoStoreModule = typeof import("../../modules/todos/frontend/src/store.ts");

interface NativeMock {
  readTodos: (repoPath: string) => Promise<TodoFile[]>;
  toggleTodo: (
    filePath: string,
    line: number,
    expectedText: string,
    checked: boolean,
  ) => Promise<void>;
  addTodo: (
    repoPath: string,
    filePath: string | null,
    text: string,
    sectionLine: number | null,
    kanban: boolean,
  ) => Promise<void>;
  moveTodo: (
    filePath: string,
    line: number,
    expectedText: string,
    targetSectionLine: number,
    setChecked: boolean | null,
  ) => Promise<void>;
}

const virtualNativeId = "\0todos-native-characterization";
const nativeGlobal = globalThis as typeof globalThis & { __shepTodoNativeMock: NativeMock };

const nativePlugin: Plugin = {
  name: "todos-native-characterization",
  enforce: "pre",
  resolveId(source, importer) {
    if (source === "./client" && importer?.endsWith("/modules/todos/frontend/src/store.ts")) {
      return virtualNativeId;
    }
    return null;
  },
  load(id) {
    if (id !== virtualNativeId) return null;
    return `
      const native = () => globalThis.__shepTodoNativeMock;
      export const readTodos = (...args) => native().readTodos(...args);
      export const toggleTodo = (...args) => native().toggleTodo(...args);
      export const addTodo = (...args) => native().addTodo(...args);
      export const moveTodo = (...args) => native().moveTodo(...args);
    `;
  },
};

let vite: ViteDevServer;
let useTodoStore: TodoStoreModule["useTodoStore"];
let calls: Array<{ operation: string; args: unknown[] }>;
let readImplementations: Map<string, () => Promise<TodoFile[]>>;
let toggleError: Error | null;

function todoFile(repoPath: string, text: string): TodoFile {
  return {
    path: `${repoPath}/TODO.md`,
    relativePath: "TODO.md",
    sections: [],
    items: [{
      line: 0,
      text,
      checked: false,
      indent: 0,
      section: null,
      sectionLine: null,
    }],
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
  ({ useTodoStore } = await vite.ssrLoadModule(
    "/modules/todos/frontend/src/store.ts",
  ) as TodoStoreModule);
});

after(async () => {
  await vite.close();
  delete (globalThis as Partial<typeof nativeGlobal>).__shepTodoNativeMock;
});

beforeEach(() => {
  calls = [];
  readImplementations = new Map();
  toggleError = null;
  nativeGlobal.__shepTodoNativeMock = {
    async readTodos(repoPath) {
      calls.push({ operation: "readTodos", args: [repoPath] });
      return (readImplementations.get(repoPath) ?? (async () => []))();
    },
    async toggleTodo(...args) {
      calls.push({ operation: "toggleTodo", args });
      if (toggleError) throw toggleError;
    },
    async addTodo(...args) {
      calls.push({ operation: "addTodo", args });
    },
    async moveTodo(...args) {
      calls.push({ operation: "moveTodo", args });
    },
  };
  useTodoStore.setState({ projectTodos: {} });
});

test("refreshAll merges fulfilled projects and leaves failed caches untouched", async () => {
  const oldA = todoFile("/a", "old a");
  const oldB = todoFile("/b", "old b");
  const nextA = todoFile("/a", "next a");
  useTodoStore.setState({ projectTodos: { "/a": [oldA], "/b": [oldB] } });
  readImplementations.set("/a", async () => [nextA]);
  readImplementations.set("/b", async () => {
    throw new Error("missing repo");
  });

  await useTodoStore.getState().refreshAll(["/a", "/b"]);

  assert.deepEqual(useTodoStore.getState().projectTodos, {
    "/a": [nextA],
    "/b": [oldB],
  });
});

test("toggle forwards optimistic-concurrency fields and refreshes after failure", async () => {
  const refreshed = todoFile("/repo", "changed on disk");
  readImplementations.set("/repo", async () => [refreshed]);
  toggleError = new Error("stale item");

  await assert.rejects(
    useTodoStore.getState().toggleItem("/repo", "/repo/TODO.md", 7, "old text", true),
    /stale item/,
  );

  assert.deepEqual(calls, [
    { operation: "toggleTodo", args: ["/repo/TODO.md", 7, "old text", true] },
    { operation: "readTodos", args: ["/repo"] },
  ]);
  assert.deepEqual(useTodoStore.getState().projectTodos["/repo"], [refreshed]);
});

test("add and move preserve native argument order and refresh after mutation", async () => {
  const refreshed = todoFile("/repo", "new item");
  readImplementations.set("/repo", async () => [refreshed]);

  await useTodoStore.getState().addItem(
    "/repo",
    "/repo/TODO.md",
    "new item",
    4,
    true,
  );
  await useTodoStore.getState().moveItem(
    "/repo",
    "/repo/TODO.md",
    8,
    "new item",
    12,
    false,
  );

  assert.deepEqual(calls, [
    { operation: "addTodo", args: ["/repo", "/repo/TODO.md", "new item", 4, true] },
    { operation: "readTodos", args: ["/repo"] },
    { operation: "moveTodo", args: ["/repo/TODO.md", 8, "new item", 12, false] },
    { operation: "readTodos", args: ["/repo"] },
  ]);
});

test("removing a project evicts only its render cache", () => {
  const a = todoFile("/a", "a");
  const b = todoFile("/b", "b");
  useTodoStore.setState({ projectTodos: { "/a": [a], "/b": [b] } });

  useTodoStore.getState().removeProject("/a");

  assert.deepEqual(useTodoStore.getState().projectTodos, { "/b": [b] });
});
