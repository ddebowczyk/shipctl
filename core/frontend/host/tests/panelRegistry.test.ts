import assert from "node:assert/strict";
import test from "node:test";

import {
  PanelRegistrationError,
  PanelRegistry,
} from "../panelRegistry.ts";

function contribution(
  id: `${string}.${string}`,
  moduleId: string,
  order?: number,
) {
  return {
    id,
    moduleId,
    scope: "project" as const,
    label: id,
    icon: { name: "test" },
    singleton: "per-project" as const,
    order,
    load: async () => ({ default: () => null }),
  };
}

test("registry rejects contribution IDs without a namespace", () => {
  const registry = new PanelRegistry();

  assert.throws(
    () => registry.register({
      ...contribution("test.panel", "test"),
      id: "panel" as `${string}.${string}`,
    }),
    (error) => error instanceof PanelRegistrationError
      && error.code === "invalid-id"
      && error.contributionId === "panel",
  );
});

test("registry rejects duplicate contribution IDs", () => {
  const registry = PanelRegistry.create([contribution("first.panel", "first")]);

  assert.throws(
    () => registry.register(contribution("first.panel", "second")),
    (error) => error instanceof PanelRegistrationError
      && error.code === "duplicate-id"
      && error.message.includes('"first"')
      && error.message.includes('"second"'),
  );
});

test("registry lookup and ordering are deterministic", () => {
  const registry = PanelRegistry.create([
    contribution("example.zeta", "example", 20),
    contribution("example.beta", "example", 10),
    contribution("example.alpha", "example", 10),
  ]);

  assert.equal(registry.has("example.beta"), true);
  assert.equal(registry.panel("example.beta")?.moduleId, "example");
  assert.equal(registry.panel("missing.panel"), undefined);
  assert.deepEqual(
    registry.list().map(({ id }) => id),
    ["example.alpha", "example.beta", "example.zeta"],
  );
});
