import type { Terminal } from "@xterm/xterm";
import type { TerminalId } from "./types.ts";

/** The slice of xterm driven by the terminal output queue. */
export type OutputTerminal = Pick<Terminal, "write">;

// Preserve the renderer-side limits already used by Shipctl. Host flow control
// is now per-attachment; exceeding this local parser budget requests a replay
// instead of truncating output or stalling the process.
const MAX_WRITE_CHUNK_BYTES = 64 * 1024;
const MAX_PENDING_OUTPUT_BYTES = 1024 * 1024;

interface TerminalRegistration {
  term: OutputTerminal;
  afterDrain: (() => void) | null;
  onOverflow: (() => void) | null;
}

interface WriteQueue {
  chunks: Uint8Array[];
  length: number;
  writing: boolean;
  overflowed: boolean;
}

const terminalInstances = new Map<TerminalId, TerminalRegistration>();
const writeQueues = new Map<TerminalId, WriteQueue>();

export function registerTerminal(
  terminalId: TerminalId,
  term: OutputTerminal,
  afterDrain: (() => void) | null = null,
  onOverflow: (() => void) | null = null,
): void {
  terminalInstances.set(terminalId, { term, afterDrain, onOverflow });
  writeQueues.set(terminalId, {
    chunks: [],
    length: 0,
    writing: false,
    overflowed: false,
  });
}

export function unregisterTerminal(terminalId: TerminalId): void {
  terminalInstances.delete(terminalId);
  writeQueues.delete(terminalId);
}

function takeWriteChunk(queue: WriteQueue): Uint8Array {
  const length = Math.min(queue.length, MAX_WRITE_CHUNK_BYTES);
  const result = new Uint8Array(length);
  let offset = 0;

  while (offset < length && queue.chunks.length > 0) {
    const first = queue.chunks[0];
    const take = Math.min(length - offset, first.byteLength);
    result.set(first.subarray(0, take), offset);
    offset += take;
    queue.length -= take;
    if (take === first.byteLength) queue.chunks.shift();
    else queue.chunks[0] = first.slice(take);
  }

  return result;
}

function requestReplay(
  registration: TerminalRegistration,
  queue: WriteQueue,
): void {
  if (queue.overflowed) return;
  queue.overflowed = true;
  queue.chunks = [];
  queue.length = 0;
  registration.onOverflow?.();
}

function drainWriteQueue(terminalId: TerminalId): void {
  const registration = terminalInstances.get(terminalId);
  const queue = writeQueues.get(terminalId);
  if (!registration || !queue || queue.writing || queue.length === 0 || queue.overflowed) {
    return;
  }

  const chunk = takeWriteChunk(queue);
  if (chunk.byteLength === 0) return;
  queue.writing = true;

  try {
    registration.term.write(chunk, () => {
      const currentQueue = writeQueues.get(terminalId);
      const currentRegistration = terminalInstances.get(terminalId);
      if (!currentQueue || currentRegistration !== registration) return;

      currentQueue.writing = false;
      if (currentQueue.length === 0) registration.afterDrain?.();
      drainWriteQueue(terminalId);
    });
  } catch (error) {
    queue.writing = false;
    requestReplay(registration, queue);
    if (import.meta.env?.DEV) {
      console.error("Failed to write terminal output:", error);
    }
  }
}

/** Queue exact PTY bytes for the mounted xterm parser. */
export function writeTerminalOutput(
  terminalId: TerminalId,
  data: readonly number[] | Uint8Array,
): void {
  const registration = terminalInstances.get(terminalId);
  const queue = writeQueues.get(terminalId);
  if (!registration || !queue || queue.overflowed || data.length === 0) return;

  const bytes = data instanceof Uint8Array ? data.slice() : Uint8Array.from(data);
  if (queue.length + bytes.byteLength > MAX_PENDING_OUTPUT_BYTES) {
    requestReplay(registration, queue);
    return;
  }

  queue.chunks.push(bytes);
  queue.length += bytes.byteLength;
  drainWriteQueue(terminalId);
}
