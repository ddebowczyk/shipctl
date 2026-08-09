import assert from "node:assert/strict";
import { test } from "node:test";

import {
  registerTerminal,
  unregisterTerminal,
  writeTerminalOutput,
  type OutputTerminal,
} from "../terminalOutputQueue.ts";
import type { TerminalId } from "../types.ts";

const MAX_WRITE_CHUNK_BYTES = 64 * 1024;
const MAX_PENDING_OUTPUT_BYTES = 1024 * 1024;

function terminalId(value: string): TerminalId {
  return value as TerminalId;
}

interface FakeTerminal extends OutputTerminal {
  chunks: Uint8Array[];
}

function createFakeTerminal(): FakeTerminal {
  const chunks: Uint8Array[] = [];
  return {
    chunks,
    write(data: string | Uint8Array, callback?: () => void) {
      chunks.push(typeof data === "string" ? new TextEncoder().encode(data) : data.slice());
      if (callback) queueMicrotask(callback);
    },
  };
}

function combined(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("replay bytes are parsed before immediately queued live bytes", async () => {
  const id = terminalId("terminal-replay-live");
  const term = createFakeTerminal();
  registerTerminal(id, term);

  writeTerminalOutput(id, new TextEncoder().encode("replay"));
  writeTerminalOutput(id, new TextEncoder().encode("-live"));
  await settle();

  assert.equal(new TextDecoder().decode(combined(term.chunks)), "replay-live");
  unregisterTerminal(id);
});

test("a large write is split into bounded exact byte chunks", async () => {
  const id = terminalId("terminal-chunks");
  const term = createFakeTerminal();
  registerTerminal(id, term);
  const payload = new Uint8Array(MAX_WRITE_CHUNK_BYTES + 1000).fill(0x78);

  writeTerminalOutput(id, payload);
  await settle();

  assert.ok(term.chunks.length > 1);
  for (const chunk of term.chunks) assert.ok(chunk.length <= MAX_WRITE_CHUNK_BYTES);
  assert.deepEqual(combined(term.chunks), payload);
  unregisterTerminal(id);
});

test("the queue preserves non-UTF-8 terminal bytes", async () => {
  const id = terminalId("terminal-binary");
  const term = createFakeTerminal();
  registerTerminal(id, term);
  const payload = Uint8Array.from([0, 0xff, 0x80, 0x1b, 0x5b, 0x6d]);

  writeTerminalOutput(id, payload);
  await settle();

  assert.deepEqual(combined(term.chunks), payload);
  unregisterTerminal(id);
});

test("the after-drain hook runs after the complete ordered parser backlog", async () => {
  const id = terminalId("terminal-after-write");
  const term = createFakeTerminal();
  let afterWrites = 0;
  registerTerminal(id, term, () => {
    afterWrites += 1;
  });

  writeTerminalOutput(id, new Uint8Array(MAX_WRITE_CHUNK_BYTES + 1));
  await settle();

  assert.equal(term.chunks.length, 2);
  assert.equal(afterWrites, 1);
  unregisterTerminal(id);
});

test("local parser backlog overflow requests one replay and stops accepting bytes", () => {
  const id = terminalId("terminal-overflow");
  const callbacks: Array<() => void> = [];
  const chunks: Uint8Array[] = [];
  const term: FakeTerminal = {
    chunks,
    write(data: string | Uint8Array, callback?: () => void) {
      chunks.push(typeof data === "string" ? new TextEncoder().encode(data) : data.slice());
      if (callback) callbacks.push(callback);
    },
  };
  let replayRequests = 0;
  registerTerminal(id, term, null, () => {
    replayRequests += 1;
  });

  writeTerminalOutput(id, Uint8Array.of(1));
  writeTerminalOutput(id, new Uint8Array(MAX_PENDING_OUTPUT_BYTES + 1));
  writeTerminalOutput(id, Uint8Array.of(2));

  assert.equal(replayRequests, 1);
  assert.equal(chunks.length, 1, "overflowed bytes reached xterm instead of reattaching");
  callbacks[0]?.();
  unregisterTerminal(id);
});

test("a late parser callback from an old attachment generation is ignored", async () => {
  const id = terminalId("terminal-generation");
  let oldCallback: (() => void) | undefined;
  const oldTerm: FakeTerminal = {
    chunks: [],
    write(data: string | Uint8Array, callback?: () => void) {
      this.chunks.push(typeof data === "string" ? new TextEncoder().encode(data) : data.slice());
      oldCallback = callback;
    },
  };
  registerTerminal(id, oldTerm);
  writeTerminalOutput(id, Uint8Array.of(1));

  unregisterTerminal(id);
  const replacement = createFakeTerminal();
  registerTerminal(id, replacement);
  oldCallback?.();
  writeTerminalOutput(id, Uint8Array.of(2));
  await settle();

  assert.deepEqual(combined(replacement.chunks), Uint8Array.of(2));
  unregisterTerminal(id);
});

test("bytes received with no mounted renderer are not retained locally", async () => {
  const id = terminalId("terminal-detached");
  writeTerminalOutput(id, new TextEncoder().encode("obsolete-tail"));

  const term = createFakeTerminal();
  registerTerminal(id, term);
  writeTerminalOutput(id, new TextEncoder().encode("authoritative-replay"));
  await settle();

  assert.equal(new TextDecoder().decode(combined(term.chunks)), "authoritative-replay");
  unregisterTerminal(id);
});
