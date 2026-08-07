import assert from "node:assert/strict";
import { test } from "node:test";

import { createGlobalCapabilityDataPort } from "../../src/core/modules/globalCapabilityData.ts";

test("global reads and replacements stay capability scoped", async () => {
  const values = new Map<string, unknown>([
    ["fixture.one", { density: "compact" }],
    ["fixture.two", { enabled: true }],
  ]);
  const port = createGlobalCapabilityDataPort({
    read: async (capabilityId) => values.get(capabilityId),
    replace: async (capabilityId, value) => {
      values.set(capabilityId, value);
    },
  });

  await port.replace("fixture.one", { density: "comfortable" });

  assert.deepEqual(await port.read("fixture.one"), { density: "comfortable" });
  assert.deepEqual(await port.read("fixture.two"), { enabled: true });
});

test("global writes are serialized and failures do not poison later work", async () => {
  const calls: string[] = [];
  let releaseFirst: (() => void) | null = null;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let shouldFail = true;
  const port = createGlobalCapabilityDataPort({
    read: async () => undefined,
    replace: async (capabilityId) => {
      calls.push(capabilityId);
      if (capabilityId === "fixture.first") await firstBlocked;
      if (capabilityId === "fixture.failing" && shouldFail) {
        shouldFail = false;
        throw new Error("write denied");
      }
    },
  });

  const first = port.replace("fixture.first", {});
  const second = port.replace("fixture.second", {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["fixture.first"]);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ["fixture.first", "fixture.second"]);

  await assert.rejects(port.replace("fixture.failing", {}), /write denied/);
  await port.replace("fixture.recovered", {});
  assert.equal(calls.at(-1), "fixture.recovered");
});

test("empty capability IDs are rejected before persistence", async () => {
  const port = createGlobalCapabilityDataPort({
    read: async () => undefined,
    replace: async () => undefined,
  });

  await assert.rejects(port.read("  "), /must not be empty/);
  await assert.rejects(port.replace("", null), /must not be empty/);
});
