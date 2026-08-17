import assert from "node:assert/strict";
import test from "node:test";

import {
  observeModuleRegistryRevisions,
  type ModuleRegistryRevisionEvent,
} from "../moduleControl.ts";

test("module revision transport owns its instance-scoped Channel lifecycle", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const channel = {
    onmessage: null as ((event: ModuleRegistryRevisionEvent) => void) | null,
  };
  const observed: number[] = [];
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args });
    return (command === "observe_module_registry_revisions" ? "observer-one" : true) as T;
  };

  const unobserve = await observeModuleRegistryRevisions(
    (event) => observed.push(event.registryRevision),
    invoke,
    () => channel,
  );
  channel.onmessage?.({ schemaVersion: 1, registryRevision: 7 });
  unobserve();

  assert.deepEqual(observed, [7]);
  assert.deepEqual(calls.map(({ command }) => command), [
    "observe_module_registry_revisions",
    "stop_module_registry_revision_observer",
  ]);
  assert.equal(calls[0]?.args?.onRevision, channel);
  assert.equal(calls[1]?.args?.observerId, "observer-one");
  assert.equal(channel.onmessage, null);
});
