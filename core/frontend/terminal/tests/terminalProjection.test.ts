import assert from "node:assert/strict";
import { test } from "node:test";

import {
  reconcileTerminalProjection,
  upsertTerminalProjection,
  type TerminalProjectProjections,
} from "../terminalProjection.ts";
import type {
  TerminalDescriptor,
  TerminalId,
  TerminalRevision,
} from "../types.ts";

function descriptor(
  id: string,
  revision: number,
  lifecycle: TerminalDescriptor["lifecycle"] = "running",
): TerminalDescriptor {
  return {
    id: id as TerminalId,
    revision: revision as TerminalRevision,
    lifecycle,
    exit: lifecycle === "exited"
      ? { code: 0, reason: "process_exit", observedAtMs: 20 }
      : null,
    metadata: {
      label: `Terminal ${id}`,
      cwd: `/repos/${id}`,
      projectPath: `/repos/${id}`,
      displayCommand: "shell",
      createdAtMs: 10,
      owner: { type: "core" },
      ownerMetadata: null,
      presentation: null,
    },
    columns: 80,
    rows: 24,
    lastOutputAtMs: null,
    agentActivity: null,
  };
}

const EMPTY: TerminalProjectProjections = {};

test("complete host inventory is idempotent and uses stable terminal view ids", () => {
  const first = reconcileTerminalProjection(EMPTY, [descriptor("one", 1)]);
  const second = reconcileTerminalProjection(first, [descriptor("one", 1)]);

  assert.deepEqual(second, first);
  assert.equal(first["/repos/one"].tabs.length, 1);
  assert.equal(first["/repos/one"].tabs[0].id, "terminal:one");
});

test("an older descriptor cannot overwrite a newer lifecycle projection", () => {
  const exited = upsertTerminalProjection(EMPTY, descriptor("one", 3, "exited"));
  const stale = upsertTerminalProjection(exited, descriptor("one", 2, "running"));

  assert.equal(stale["/repos/one"].tabs[0].kind, "terminal");
  assert.equal(
    stale["/repos/one"].tabs[0].kind === "terminal"
      ? stale["/repos/one"].tabs[0].lifecycle
      : null,
    "exited",
  );
});

test("host-absent views are removed locally while exited host records remain", () => {
  const initial = reconcileTerminalProjection(EMPTY, [
    descriptor("gone", 1),
    descriptor("exited", 2, "exited"),
  ]);
  const reconciled = reconcileTerminalProjection(initial, [
    descriptor("exited", 2, "exited"),
  ]);

  assert.equal(reconciled["/repos/gone"].tabs.length, 0);
  assert.equal(reconciled["/repos/exited"].tabs.length, 1);
});
