import assert from "node:assert/strict";
import test from "node:test";

import {
  notifyUsageIngestCompleted,
  subscribeUsageIngestCompleted,
} from "../src/ingestCompleted.ts";

test("usage completion fan-out removes disposed surfaces and contains a failed listener", async () => {
  const calls: string[] = [];
  const removeDisposed = subscribeUsageIngestCompleted(() => { calls.push("disposed"); });
  const removeFailing = subscribeUsageIngestCompleted(() => {
    calls.push("failing");
    throw new Error("surface failure");
  });
  const removeHealthy = subscribeUsageIngestCompleted(() => { calls.push("healthy"); });

  removeDisposed();
  await notifyUsageIngestCompleted();
  assert.deepEqual(calls, ["failing", "healthy"]);

  removeFailing();
  removeHealthy();
  await notifyUsageIngestCompleted();
  assert.deepEqual(calls, ["failing", "healthy"]);
});
