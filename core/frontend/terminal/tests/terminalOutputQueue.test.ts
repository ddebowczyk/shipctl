import assert from "node:assert/strict";
import { test } from "node:test";

import {
  flushPendingOutput,
  registerTerminal,
  setOutputAcknowledger,
  unregisterTerminal,
  writeTerminalOutput,
  type OutputTerminal,
} from "../terminalOutputQueue.ts";

// Mirrors of the queue's internal sizes. They are asserted against behavior
// here rather than exported, so a change to either side shows up as a failure.
const MAX_WRITE_CHUNK_CHARS = 64 * 1024;
const MAX_PENDING_OUTPUT_CHARS = 1024 * 1024;
const OUTPUT_ACK_INTERVAL_BYTES = 5_000;
const TRUNCATED_MARKER = "\r\n[output truncated while terminal was unavailable]\r\n";

interface FakeTerminal extends OutputTerminal {
  chunks: string[];
}

/** A terminal that completes each write asynchronously, as xterm's parser does. */
function createFakeTerminal(): FakeTerminal {
  const chunks: string[] = [];
  return {
    chunks,
    write(data: string | Uint8Array, callback?: () => void) {
      chunks.push(typeof data === "string" ? data : new TextDecoder().decode(data));
      if (callback) queueMicrotask(callback);
    },
  };
}

/** Let every queued microtask — the whole write/acknowledge chain — settle. */
function settle(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function silentAcknowledger() {
  const calls: Array<{ ptyId: number; bytes: number }> = [];
  setOutputAcknowledger((ptyId, bytes) => {
    calls.push({ ptyId, bytes });
    return Promise.resolve();
  });
  return calls;
}

test("writes reach an attached terminal in order", async () => {
  const ptyId = 1;
  silentAcknowledger();
  const term = createFakeTerminal();
  registerTerminal(ptyId, term);

  writeTerminalOutput(ptyId, "one ");
  writeTerminalOutput(ptyId, "two ");
  writeTerminalOutput(ptyId, "three");
  await settle();

  assert.equal(term.chunks.join(""), "one two three");
  unregisterTerminal(ptyId);
});

test("output produced before a terminal attaches is buffered, then flushed", async () => {
  const ptyId = 2;
  silentAcknowledger();

  writeTerminalOutput(ptyId, "early ");
  writeTerminalOutput(ptyId, "output");

  const term = createFakeTerminal();
  registerTerminal(ptyId, term);
  flushPendingOutput(ptyId);
  await settle();

  assert.equal(term.chunks.join(""), "early output");
  unregisterTerminal(ptyId);
});

test("a single write is split into bounded chunks", async () => {
  const ptyId = 3;
  silentAcknowledger();
  const term = createFakeTerminal();
  registerTerminal(ptyId, term);

  const payload = "x".repeat(MAX_WRITE_CHUNK_CHARS + 1000);
  writeTerminalOutput(ptyId, payload);
  await settle();

  assert.ok(term.chunks.length > 1, "expected more than one write");
  for (const chunk of term.chunks) {
    assert.ok(chunk.length <= MAX_WRITE_CHUNK_CHARS, "chunk exceeded the write bound");
  }
  assert.equal(term.chunks.join(""), payload);
  unregisterTerminal(ptyId);
});

test("a chunk boundary never splits a surrogate pair", async () => {
  const ptyId = 4;
  silentAcknowledger();
  const term = createFakeTerminal();
  registerTerminal(ptyId, term);

  // The pair straddles the chunk bound: its high half sits at the last index a
  // full-size chunk would take.
  const payload = "a".repeat(MAX_WRITE_CHUNK_CHARS - 1) + "\u{1F600}" + "b";
  writeTerminalOutput(ptyId, payload);
  await settle();

  assert.equal(term.chunks[0].length, MAX_WRITE_CHUNK_CHARS - 1);
  assert.equal(term.chunks[1], "\u{1F600}b");
  assert.equal(term.chunks.join(""), payload);
  for (const chunk of term.chunks) {
    assert.ok(!/[\uD800-\uDBFF]$/.test(chunk), "chunk ended on a lone high surrogate");
    assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk), "chunk began on a lone low surrogate");
  }
  unregisterTerminal(ptyId);
});

test("the pre-attach buffer is bounded and reports what it dropped", async () => {
  const ptyId = 5;
  silentAcknowledger();

  writeTerminalOutput(ptyId, "0".repeat(MAX_PENDING_OUTPUT_CHARS));
  writeTerminalOutput(ptyId, "1".repeat(1000));

  const term = createFakeTerminal();
  registerTerminal(ptyId, term);
  flushPendingOutput(ptyId);
  await settle();

  const written = term.chunks.join("");
  assert.ok(written.startsWith(TRUNCATED_MARKER), "missing truncation marker");
  const body = written.slice(TRUNCATED_MARKER.length);
  assert.equal(body.length, MAX_PENDING_OUTPUT_CHARS);
  // The newest output survives; the oldest 1000 characters were dropped.
  assert.ok(body.endsWith("1".repeat(1000)));
  assert.equal(body.slice(0, 1), "0");
  unregisterTerminal(ptyId);
});

test("front-dropping never leaves a lone low surrogate", async () => {
  const ptyId = 6;
  silentAcknowledger();

  // One character over the bound, with a surrogate pair at the very front, so
  // the naive drop length would cut the pair in half.
  writeTerminalOutput(ptyId, "\u{1F600}" + "a".repeat(MAX_PENDING_OUTPUT_CHARS - 1));

  const term = createFakeTerminal();
  registerTerminal(ptyId, term);
  flushPendingOutput(ptyId);
  await settle();

  const body = term.chunks.join("").slice(TRUNCATED_MARKER.length);
  assert.equal(body, "a".repeat(MAX_PENDING_OUTPUT_CHARS - 1));
  unregisterTerminal(ptyId);
});

test("acknowledgements accumulate to the interval and count UTF-8 bytes", async () => {
  const ptyId = 7;
  const calls = silentAcknowledger();
  const term = createFakeTerminal();
  registerTerminal(ptyId, term);

  writeTerminalOutput(ptyId, "a".repeat(OUTPUT_ACK_INTERVAL_BYTES - 1));
  await settle();
  assert.equal(calls.length, 0, "acknowledged below the interval");

  // Two-byte characters: the host counts bytes, not UTF-16 code units.
  writeTerminalOutput(ptyId, "é".repeat(500));
  await settle();

  assert.deepEqual(calls, [
    { ptyId, bytes: OUTPUT_ACK_INTERVAL_BYTES - 1 + 1000 },
  ]);
  unregisterTerminal(ptyId);
});

test("a failed acknowledgement re-credits its bytes and retries", async () => {
  const ptyId = 8;
  const attempts: number[] = [];
  let failNext = true;
  setOutputAcknowledger((_ptyId, bytes) => {
    attempts.push(bytes);
    if (failNext) {
      failNext = false;
      return Promise.reject(new Error("host unavailable"));
    }
    return Promise.resolve();
  });

  const term = createFakeTerminal();
  registerTerminal(ptyId, term);
  writeTerminalOutput(ptyId, "a".repeat(OUTPUT_ACK_INTERVAL_BYTES));
  await settle();

  assert.deepEqual(attempts, [OUTPUT_ACK_INTERVAL_BYTES]);

  // The retry timer is the queue's own; wait past it rather than reach inside.
  await settle(400);
  assert.deepEqual(
    attempts,
    [OUTPUT_ACK_INTERVAL_BYTES, OUTPUT_ACK_INTERVAL_BYTES],
    "the failed bytes were dropped instead of retried",
  );
  unregisterTerminal(ptyId);
});

test("the after-write hook runs once per completed chunk", async () => {
  const ptyId = 9;
  silentAcknowledger();
  const term = createFakeTerminal();
  let afterWrites = 0;
  registerTerminal(ptyId, term, () => {
    afterWrites += 1;
  });

  writeTerminalOutput(ptyId, "y".repeat(MAX_WRITE_CHUNK_CHARS + 1));
  await settle();

  assert.equal(term.chunks.length, 2);
  assert.equal(afterWrites, 2);
  unregisterTerminal(ptyId);
});

test("a detached terminal stops receiving; the next one gets the gap", async () => {
  const ptyId = 10;
  const calls = silentAcknowledger();
  const term = createFakeTerminal();
  registerTerminal(ptyId, term);

  writeTerminalOutput(ptyId, "before");
  await settle();
  unregisterTerminal(ptyId);

  // A tab switch detaches the terminal; output produced meanwhile belongs to
  // whichever terminal attaches next, not to the disposed one.
  writeTerminalOutput(ptyId, "during");
  await settle();
  assert.equal(term.chunks.join(""), "before");

  const replacement = createFakeTerminal();
  registerTerminal(ptyId, replacement);
  flushPendingOutput(ptyId);
  await settle();
  assert.equal(replacement.chunks.join(""), "during");
  assert.equal(calls.length, 0, "sub-interval bytes were acknowledged");
  unregisterTerminal(ptyId);
});

test("unregistering discards an unflushed backlog", async () => {
  const ptyId = 11;
  silentAcknowledger();

  writeTerminalOutput(ptyId, "output from a session that ended");
  // usePty unregisters when the PTY exits: that backlog has no reader left.
  unregisterTerminal(ptyId);

  const term = createFakeTerminal();
  registerTerminal(ptyId, term);
  flushPendingOutput(ptyId);
  await settle();

  assert.equal(term.chunks.join(""), "");
  unregisterTerminal(ptyId);
});
