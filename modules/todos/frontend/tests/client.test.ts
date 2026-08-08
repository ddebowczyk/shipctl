import assert from "node:assert/strict";
import test from "node:test";

import { TODO_COMMANDS } from "../src/client.ts";

test("TODO frontend targets only namespaced plugin commands", () => {
  assert.deepEqual(TODO_COMMANDS, {
    read: "plugin:shipctl-todos|read_todos",
    toggle: "plugin:shipctl-todos|toggle_todo",
    add: "plugin:shipctl-todos|add_todo",
    move: "plugin:shipctl-todos|move_todo",
  });
});
