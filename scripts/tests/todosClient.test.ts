import assert from "node:assert/strict";
import test from "node:test";

import { TODO_COMMANDS } from "../../modules/todos/frontend/src/client.ts";

test("TODO frontend targets only namespaced plugin commands", () => {
  assert.deepEqual(TODO_COMMANDS, {
    read: "plugin:shep-todos|read_todos",
    toggle: "plugin:shep-todos|toggle_todo",
    add: "plugin:shep-todos|add_todo",
    move: "plugin:shep-todos|move_todo",
  });
});
