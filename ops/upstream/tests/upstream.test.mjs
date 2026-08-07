import assert from "node:assert/strict";
import test from "node:test";

import { assertClosable, parseFrontmatter, validateQueueEntry } from "../bin/upstream.mjs";

const commit = {
  short: "59e8fc7",
  subject: "Fix terminal output flow and scroll behavior",
  authored: "2026-08-06",
};

function entry(overrides = {}) {
  return {
    upstream: commit.short,
    subject: commit.subject,
    authored: commit.authored,
    verdict: "n-a",
    ...overrides,
  };
}

test("parses scalar and inline-array frontmatter", () => {
  const parsed = parseFrontmatter(`---
upstream: "59e8fc7"
subject: "Fix terminal output flow and scroll behavior"
authored: "2026-08-06"
verdict: adapt
integration: variant
bd: [shep-123, shep-456]
---
`);
  assert.deepEqual(parsed.bd, ["shep-123", "shep-456"]);
  assert.equal(parsed.verdict, "adapt");
});

test("parses block-array frontmatter", () => {
  const parsed = parseFrontmatter(`---
upstream: 59e8fc7
subject: "Quoted \\"subject\\""
authored: "2026-08-06"
verdict: adapt
bd:
  - shep-123
  - shep-456
---
`);
  assert.equal(parsed.subject, 'Quoted "subject"');
  assert.deepEqual(parsed.bd, ["shep-123", "shep-456"]);
});

test("stub consistency rejects metadata drift", () => {
  assert.throws(() => validateQueueEntry(commit, entry({ subject: "changed" })), /subject drifted/);
});

test("close refuses a pending entry", () => {
  const entries = new Map([[commit.short, entry({ verdict: "pending" })]]);
  assert.throws(() => assertClosable([commit], entries), /verdict is pending/);
});

test("close requires tracked work for adopt and adapt", () => {
  const entries = new Map([[commit.short, entry({ verdict: "adapt", integration: "variant" })]]);
  assert.throws(() => assertClosable([commit], entries), /requires a bd issue/);
  entries.set(commit.short, entry({ verdict: "adapt", integration: "variant", bd: ["shep-123"] }));
  assert.doesNotThrow(() => assertClosable([commit], entries));
});
