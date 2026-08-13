import assert from "node:assert/strict";
import test from "node:test";

import type {
  CommandContribution,
  CommandInvocationContext,
  ShipctlModule,
} from "@shipctl/module-api";

import {
  CommandRegistryError,
  createCommandRegistry,
} from "../commandRegistry.ts";

const context: CommandInvocationContext = {
  activeProjectId: "/workspace/project",
  openPanel: () => undefined,
};

function command(overrides: Partial<CommandContribution> = {}): CommandContribution {
  return {
    id: "fixture.run",
    moduleId: "shipctl.fixture",
    label: "Run fixture",
    run: () => undefined,
    ...overrides,
  };
}

test("registry dispatches one static bundled command through its handler port", async () => {
  const calls: string[] = [];
  const module: ShipctlModule = {
    id: "shipctl.fixture",
    version: "1.0.0",
    commands: [command({ run: ({ activeProjectId }) => calls.push(activeProjectId ?? "none") })],
  };
  const registry = createCommandRegistry({ modules: [module] });

  assert.deepEqual(registry.commands().map(({ id }) => id), ["fixture.run"]);
  assert.deepEqual(await registry.dispatch("fixture.run", context), {
    status: "handled",
    command: module.commands![0],
  });
  assert.deepEqual(calls, ["/workspace/project"]);
});

test("registry keeps core and module ownership explicit", () => {
  const coreCommand = command({ id: "core.open-settings", moduleId: "core" });
  const registry = createCommandRegistry({ coreCommands: [coreCommand] });
  assert.deepEqual(registry.commands(), [coreCommand]);

  assert.throws(
    () => createCommandRegistry({
      coreCommands: [command({ id: "core.invalid-owner", moduleId: "shipctl.fixture" })],
    }),
    (error: unknown) => error instanceof CommandRegistryError
      && error.code === "command.owner_mismatch",
  );
});

test("registry rejects malformed, duplicate, and incorrectly owned static commands", () => {
  assert.throws(
    () => createCommandRegistry({
      modules: [{
        id: "shipctl.fixture",
        version: "1.0.0",
        commands: [command({ id: "fixture_command" })],
      }],
    }),
    (error: unknown) => error instanceof CommandRegistryError
      && error.code === "command.invalid_id",
  );
  assert.throws(
    () => createCommandRegistry({
      modules: [{
        id: "shipctl.fixture",
        version: "1.0.0",
        commands: [command(), command()],
      }],
    }),
    (error: unknown) => error instanceof CommandRegistryError
      && error.code === "command.duplicate_id",
  );
  assert.throws(
    () => createCommandRegistry({
      modules: [{
        id: "shipctl.fixture",
        version: "1.0.0",
        commands: [command({ moduleId: "shipctl.other" })],
      }],
    }),
    (error: unknown) => error instanceof CommandRegistryError
      && error.code === "command.owner_mismatch",
  );
});

test("registry reports disabled, failed, and unknown dispatch without a fallback switch", async () => {
  const unavailable = command({
    isEnabled: () => false,
  });
  const broken = command({
    id: "fixture.fail",
    run: () => { throw new Error("fixture failure"); },
  });
  const registry = createCommandRegistry({
    modules: [{
      id: "shipctl.fixture",
      version: "1.0.0",
      commands: [unavailable, broken],
    }],
  });

  assert.deepEqual(await registry.dispatch("fixture.run", context), {
    status: "disabled",
    command: unavailable,
  });
  const failed = await registry.dispatch("fixture.fail", context);
  assert.equal(failed.status, "failed");
  if (failed.status === "failed") {
    assert.equal(failed.command, broken);
    assert.equal((failed.error as Error).message, "fixture failure");
  }
  assert.deepEqual(await registry.dispatch("fixture.unknown", context), {
    status: "unknown",
    commandId: "fixture.unknown",
  });
});
