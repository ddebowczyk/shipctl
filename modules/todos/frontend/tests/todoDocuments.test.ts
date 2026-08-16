import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import type { ProjectDocument } from "@shipctl/module-api";
import {
  addTodoContents,
  createTodoContents,
  moveTodoContents,
  parseTodoDocument,
  toggleTodoContents,
} from "../src/todoDocuments.ts";

function document(contents: string): ProjectDocument {
  return {
    projectId: "/project",
    relativePath: "TODO.md",
    revision: "revision" as ProjectDocument["revision"],
    contents,
  };
}

test("todo parser preserves the characterized Markdown model", () => {
  const parsed = parseTodoDocument(document(
    "# TODO\n\n## Now\n1. [ ] wrapped item\n   second half\n  - [X] nested\n\n## Done\n* [x] shipped\n",
  ));
  assert.deepEqual(parsed.sections, [
    { line: 0, title: "TODO", level: 1 },
    { line: 2, title: "Now", level: 2 },
    { line: 7, title: "Done", level: 2 },
  ]);
  assert.deepEqual(parsed.items.map(({ line, text, checked, indent, sectionLine }) => ({
    line,
    text,
    checked,
    indent,
    sectionLine,
  })), [
    { line: 3, text: "wrapped item second half", checked: false, indent: 0, sectionLine: 2 },
    { line: 5, text: "nested", checked: true, indent: 2, sectionLine: 2 },
    { line: 8, text: "shipped", checked: true, indent: 0, sectionLine: 7 },
  ]);
});

test("toggle changes only the checkbox marker for generated task text", () => {
  fc.assert(fc.property(
    fc.stringMatching(/^[A-Za-z0-9](?:[A-Za-z0-9 ]*[A-Za-z0-9])?$/u),
    fc.boolean(),
    (text, checked) => {
      const source = `prefix\n- [ ] ${text}\nsuffix\n`;
      const updated = toggleTodoContents(source, 1, text, checked);
      assert.equal(updated, `prefix\n- [${checked ? "x" : " "}] ${text}\nsuffix\n`);
      assert.equal(parseTodoDocument(document(updated)).items[0].checked, checked);
    },
  ));
});

test("stale item identity fails without producing document contents", () => {
  assert.throws(
    () => toggleTodoContents("- [ ] current\n", 0, "stale", true),
    /changed on disk/,
  );
});

test("add and move retain the characterized board layout", () => {
  const initial = createTodoContents("first task", true);
  const withStarted = addTodoContents(initial, "started", 6);
  assert.equal(
    withStarted,
    "# To-dos\n\n## 📋 Backlog\n\n- [ ] first task\n\n## 🚧 In Progress\n\n- [ ] started\n\n## ✅ Done\n",
  );
  assert.equal(
    moveTodoContents(withStarted, 4, "first task", 10, true),
    "# To-dos\n\n## 📋 Backlog\n\n## 🚧 In Progress\n\n- [ ] started\n\n## ✅ Done\n\n- [x] first task\n",
  );
});
