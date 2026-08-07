import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { formatInventory, inventorySkills } from "../../bin/skills.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("ops skill inventory exposes copy-pasteable procedure paths", async () => {
  const inventory = await inventorySkills(root);
  assert.ok(inventory.length > 0);
  for (const skill of inventory) {
    assert.match(skill.path, new RegExp(`^ops/${skill.capability}/skills/[^/]+/SKILL\\.md$`));
    assert.ok(skill.name);
    assert.ok(skill.summary);
  }

  const output = formatInventory(inventory);
  for (const skill of inventory) assert.match(output, new RegExp(skill.path.replaceAll("/", "\\/")));
});
