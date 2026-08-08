import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverAggregateCommands, runAggregate } from "../bin/run-aggregate.mjs";

test("a declared fast check joins the aggregate without central wiring", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shipctl-check-lane-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capability = join(root, "ops", "probe");
  await mkdir(capability, { recursive: true });
  await writeFile(
    join(capability, "capability.yaml"),
    `---
id: probe
commands:
  - name: joined
    lane: fast
    aggregate: check
  - name: excluded
    lane: fast
    aggregate: test
`,
  );

  assert.deepEqual(discoverAggregateCommands(root, "check"), [
    { capability: "probe", command: "joined" },
  ]);
});

test("a failed aggregate command identifies its capability and command", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shipctl-check-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capability = join(root, "ops", "probe");
  await mkdir(capability, { recursive: true });
  await writeFile(
    join(capability, "capability.yaml"),
    `---
id: probe
commands:
  - name: fail
    lane: fast
    aggregate: check
`,
  );
  await writeFile(join(root, "justfile"), "probe command:\n    @exit 23\n");

  const output = [];
  t.mock.method(console, "log", (...parts) => output.push(parts.join(" ")));

  assert.equal(runAggregate(root, "check"), 23);
  assert.deepEqual(output, ["==> just probe fail"]);
});
