import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer, type ViteDevServer } from "vite";

import type { TodoFile, TodoItem, TodoSection } from "../../src/lib/types.ts";

type TodosPanelModule = typeof import("../../src/components/todos/TodosPanel.tsx");

let vite: ViteDevServer;
let buildColumns: TodosPanelModule["buildColumns"];
let isDoneColumn: TodosPanelModule["isDoneColumn"];

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({ buildColumns, isDoneColumn } = await vite.ssrLoadModule(
    "/src/components/todos/TodosPanel.tsx",
  ) as TodosPanelModule);
});

after(async () => {
  await vite.close();
});

function section(line: number, title: string, level = 2): TodoSection {
  return { line, title, level };
}

function item(
  line: number,
  text: string,
  overrides: Partial<TodoItem> = {},
): TodoItem {
  return {
    line,
    text,
    checked: false,
    indent: 0,
    section: null,
    sectionLine: null,
    ...overrides,
  };
}

function file(sections: TodoSection[], items: TodoItem[]): TodoFile {
  return {
    path: "/fixture/TODO.md",
    relativePath: "TODO.md",
    sections,
    items,
  };
}

test("done-column recognition tolerates symbols and known completion words", () => {
  for (const title of ["Done", "✅ Done", "Complete", "completed work", "Shipped", "Finished"]) {
    assert.equal(isDoneColumn(title), true, title);
  }

  for (const title of ["In Progress", "Almost done", "Finish later", "Shipment"]) {
    assert.equal(isDoneColumn(title), false, title);
  }
});

test("board columns use the item-owning heading level and roll up nested headings", () => {
  const result = buildColumns(file(
    [
      section(0, "Project", 1),
      section(2, "Backlog"),
      section(6, "Details", 3),
      section(10, "Done"),
    ],
    [
      item(1, "before columns"),
      item(4, "parent", { section: "Backlog", sectionLine: 2 }),
      item(5, "child", { indent: 2, section: "Backlog", sectionLine: 2 }),
      item(8, "nested heading item", { section: "Details", sectionLine: 6 }),
      item(12, "complete", { checked: true, section: "Done", sectionLine: 10 }),
    ],
  ));

  assert.deepEqual(result.columns.map(({ section: owner }) => owner.title), ["Backlog", "Done"]);
  assert.deepEqual(result.inbox.map(({ item: inboxItem }) => inboxItem.text), ["before columns"]);
  assert.deepEqual(
    result.columns[0].cards.map((card) => ({
      item: card.item.text,
      children: card.children.map((child) => child.text),
    })),
    [
      { item: "parent", children: ["child"] },
      { item: "nested heading item", children: [] },
    ],
  );
  assert.deepEqual(result.columns[1].cards.map((card) => card.item.text), ["complete"]);
});

test("files without headings remain a list-like inbox with nested children", () => {
  const result = buildColumns(file([], [
    item(0, "parent"),
    item(1, "child", { indent: 2 }),
    item(2, "next"),
  ]));

  assert.deepEqual(result.columns, []);
  assert.deepEqual(
    result.inbox.map((card) => ({
      item: card.item.text,
      children: card.children.map((child) => child.text),
    })),
    [
      { item: "parent", children: ["child"] },
      { item: "next", children: [] },
    ],
  );
});

test("empty boards choose the most common non-title heading level", () => {
  const result = buildColumns(file(
    [
      section(0, "Title", 1),
      section(2, "Backlog"),
      section(4, "In Progress"),
      section(6, "Done"),
    ],
    [],
  ));

  assert.deepEqual(result.columns.map(({ section: owner }) => owner.title), [
    "Backlog",
    "In Progress",
    "Done",
  ]);
});
