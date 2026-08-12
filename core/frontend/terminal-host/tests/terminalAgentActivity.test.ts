import assert from "node:assert/strict";
import { test } from "node:test";

import { getTabActivityStatus } from "../../shared/activityStatus.ts";
import {
  mergeTerminalDescriptorActivity,
  tabActivityFromDescriptor,
} from "../terminalAgentActivity.ts";
import type {
  TerminalAgentActivity,
  TerminalDescriptor,
  TerminalId,
  TerminalRevision,
} from "../types.ts";

function activity(
  revision: number,
  state: TerminalAgentActivity["state"],
  attention: TerminalAgentActivity["attention"] = null,
): TerminalAgentActivity {
  return {
    revision,
    state,
    message: attention ? "waiting for input" : null,
    updatedAtMs: 1_000 + revision,
    source: { identifier: "codex", version: "1.2.3" },
    attention,
  };
}

function descriptor(
  revision: number,
  agentActivity: TerminalAgentActivity | null,
  lifecycle: TerminalDescriptor["lifecycle"] = "running",
  exitCode: number | null = null,
): TerminalDescriptor {
  return {
    id: "00000000-0000-4000-8000-000000000001" as TerminalId,
    revision: revision as TerminalRevision,
    lifecycle,
    exit: lifecycle === "exited"
      ? { code: exitCode, reason: "process_exit", observedAtMs: 2_000 }
      : null,
    metadata: {
      label: "agent",
      cwd: "/repo",
      projectPath: "/repo",
      displayCommand: "codex",
      createdAtMs: 1,
      owner: { type: "core" },
      ownerMetadata: null,
      presentation: null,
    },
    columns: 80,
    rows: 24,
    lastOutputAtMs: 900,
    agentActivity,
  };
}

test("explicit working, blocked, completed, and idle reports project deterministically", () => {
  const working = tabActivityFromDescriptor(descriptor(2, activity(1, "working")));
  assert.equal(getTabActivityStatus(working), "active");
  assert.equal(working.agentSource, "codex@1.2.3");

  const blocked = tabActivityFromDescriptor(
    descriptor(3, activity(2, "blocked", { kind: "blocked", revision: 2 })),
    working,
  );
  assert.equal(getTabActivityStatus(blocked), "attention");
  assert.equal(blocked.agentMessage, "waiting for input");

  const completed = tabActivityFromDescriptor(
    descriptor(4, activity(3, "idle", { kind: "completed", revision: 3 })),
    blocked,
  );
  assert.equal(getTabActivityStatus(completed), "attention");
  assert.equal(completed.agentAttention, "completed");

  const idle = tabActivityFromDescriptor(descriptor(5, activity(4, "idle")), completed);
  assert.equal(getTabActivityStatus(idle), "running");
  assert.equal(idle.agentAttention, null);
});

test("activity revision cannot regress behind a newer unrelated descriptor revision", () => {
  const current = descriptor(5, activity(7, "blocked", { kind: "blocked", revision: 7 }));
  const incoming = descriptor(6, activity(6, "working"));

  const merged = mergeTerminalDescriptorActivity(current, incoming);

  assert.equal(merged.revision, 6);
  assert.equal(merged.agentActivity?.revision, 7);
  assert.equal(merged.agentActivity?.state, "blocked");
});

test("process exit remains authoritative over supplemental agent attention", () => {
  const completed = activity(3, "idle", { kind: "completed", revision: 3 });
  const success = tabActivityFromDescriptor(descriptor(6, completed, "exited", 0));
  const failed = tabActivityFromDescriptor(descriptor(6, completed, "exited", 2));

  assert.equal(getTabActivityStatus(success), "idle");
  assert.equal(getTabActivityStatus(failed), "failed");
  assert.equal(success.agentAttention, "completed");
});
