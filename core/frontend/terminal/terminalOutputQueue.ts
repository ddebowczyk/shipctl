import type { Terminal } from "@xterm/xterm";
import { acknowledgePtyOutput } from "@shipctl/core/platform";

// The terminal output seam: everything between a PTY data event arriving and
// xterm having parsed it.
//
// Three jobs, all of which the previous animation-frame batcher left open:
//
//   1. Submit bounded chunks and wait for xterm's write callback, so a large
//      redraw cannot block the main thread in one parse.
//   2. Acknowledge parsed bytes back to the host, which is what releases the
//      backend's flow-control budget and stops it running ahead of the parser.
//   3. Bound the buffer used while no terminal is attached, so output produced
//      before a tab is mounted cannot grow without limit.

/** The slice of a terminal this queue drives. */
export type OutputTerminal = Pick<Terminal, "write">;

export type OutputAcknowledger = (ptyId: number, bytes: number) => Promise<void>;

// Sizes adopted from upstream 59e8fc7 rather than chosen here.
//
// The acknowledgement interval matches the backend's low watermark, so a single
// acknowledgement is always large enough to move a paused reader back under it.
const MAX_WRITE_CHUNK_CHARS = 64 * 1024;
const MAX_PENDING_OUTPUT_CHARS = 1024 * 1024;
const OUTPUT_ACK_INTERVAL_BYTES = 5_000;
const OUTPUT_ACK_RETRY_MS = 250;
const OUTPUT_TRUNCATED_MARKER = "\r\n[output truncated while terminal was unavailable]\r\n";

const outputEncoder = new TextEncoder();

interface TerminalRegistration {
  term: OutputTerminal;
  afterWrite: (() => void) | null;
}

interface BufferedOutput {
  chunks: string[];
  length: number;
  truncatedChars: number;
}

interface WriteQueue {
  chunks: string[];
  length: number;
  writing: boolean;
}

interface OutputAckState {
  pendingBytes: number;
  sending: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

const terminalInstances = new Map<number, TerminalRegistration>();
const pendingOutput = new Map<number, BufferedOutput>();
const writeQueues = new Map<number, WriteQueue>();
const outputAckStates = new Map<number, OutputAckState>();

let acknowledgeOutput: OutputAcknowledger = acknowledgePtyOutput;

/**
 * Replace the acknowledgement transport. The default invokes the host command;
 * tests substitute their own so the queue can be exercised without a host.
 */
export function setOutputAcknowledger(acknowledger: OutputAcknowledger): void {
  acknowledgeOutput = acknowledger;
}

export function registerTerminal(
  ptyId: number,
  term: OutputTerminal,
  afterWrite: (() => void) | null = null,
) {
  terminalInstances.set(ptyId, { term, afterWrite });
}

export function unregisterTerminal(ptyId: number) {
  terminalInstances.delete(ptyId);
  pendingOutput.delete(ptyId);
  writeQueues.delete(ptyId);
  const ackState = outputAckStates.get(ptyId);
  if (ackState?.retryTimer) clearTimeout(ackState.retryTimer);
  outputAckStates.delete(ptyId);
}

/* ── acknowledgement ───────────────────────────────────── */

function acknowledgeCompletedWrite(ptyId: number, chunk: string): void {
  let state = outputAckStates.get(ptyId);
  if (!state) {
    state = { pendingBytes: 0, sending: false, retryTimer: null };
    outputAckStates.set(ptyId, state);
  }
  // The host counts the bytes it dispatched, so acknowledge in those units
  // rather than in UTF-16 code units.
  state.pendingBytes += outputEncoder.encode(chunk).byteLength;
  flushOutputAcknowledgement(ptyId, state);
}

function flushOutputAcknowledgement(ptyId: number, state: OutputAckState): void {
  if (state.sending || state.retryTimer || state.pendingBytes < OUTPUT_ACK_INTERVAL_BYTES) {
    return;
  }

  const bytes = state.pendingBytes;
  state.pendingBytes = 0;
  state.sending = true;
  void acknowledgeOutput(ptyId, bytes)
    .then(() => {
      if (outputAckStates.get(ptyId) !== state) return;
      state.sending = false;
      flushOutputAcknowledgement(ptyId, state);
    })
    .catch((error) => {
      if (outputAckStates.get(ptyId) !== state) return;
      // Put the bytes back: dropping them would strand the backend's budget
      // and stall the session permanently.
      state.pendingBytes += bytes;
      state.sending = false;
      state.retryTimer = setTimeout(() => {
        if (outputAckStates.get(ptyId) !== state) return;
        state.retryTimer = null;
        flushOutputAcknowledgement(ptyId, state);
      }, OUTPUT_ACK_RETRY_MS);
      if (import.meta.env?.DEV) {
        console.warn("Failed to acknowledge terminal output:", error);
      }
    });
}

/* ── write queue ───────────────────────────────────────── */

function takeWriteChunk(queue: WriteQueue): string {
  const parts: string[] = [];
  let remaining = MAX_WRITE_CHUNK_CHARS;

  while (remaining > 0 && queue.chunks.length > 0) {
    const first = queue.chunks[0];
    let take = Math.min(remaining, first.length);
    // Never split a UTF-16 surrogate pair across two writes: xterm would parse
    // the halves as separate replacement characters.
    if (take < first.length && take > 0) {
      const lastCodeUnit = first.charCodeAt(take - 1);
      if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) take -= 1;
    }

    if (take === 0) break;
    parts.push(first.slice(0, take));
    queue.length -= take;
    remaining -= take;
    if (take === first.length) queue.chunks.shift();
    else queue.chunks[0] = first.slice(take);
  }

  return parts.join("");
}

function drainWriteQueue(ptyId: number): void {
  const registration = terminalInstances.get(ptyId);
  const queue = writeQueues.get(ptyId);
  if (!registration || !queue || queue.writing || queue.length === 0) return;

  const chunk = takeWriteChunk(queue);
  if (chunk.length === 0) return;
  queue.writing = true;

  try {
    registration.term.write(chunk, () => {
      const currentQueue = writeQueues.get(ptyId);
      const currentRegistration = terminalInstances.get(ptyId);
      // The terminal may have been replaced while the parser was running.
      if (!currentQueue || currentRegistration !== registration) return;

      currentQueue.writing = false;
      acknowledgeCompletedWrite(ptyId, chunk);
      registration.afterWrite?.();
      drainWriteQueue(ptyId);
    });
  } catch (error) {
    queue.writing = false;
    if (import.meta.env?.DEV) {
      console.error("Failed to write terminal output:", error);
    }
  }
}

function enqueueTerminalOutput(ptyId: number, data: string): void {
  if (data.length === 0) return;
  let queue = writeQueues.get(ptyId);
  if (!queue) {
    queue = { chunks: [], length: 0, writing: false };
    writeQueues.set(ptyId, queue);
  }
  queue.chunks.push(data);
  queue.length += data.length;
  drainWriteQueue(ptyId);
}

/* ── pre-attach buffer ─────────────────────────────────── */

function appendPendingOutput(ptyId: number, data: string): void {
  let buffer = pendingOutput.get(ptyId);
  if (!buffer) {
    buffer = { chunks: [], length: 0, truncatedChars: 0 };
    pendingOutput.set(ptyId, buffer);
  }

  buffer.chunks.push(data);
  buffer.length += data.length;

  // Drop from the front: the newest output is the part a user returning to the
  // tab actually needs.
  while (buffer.length > MAX_PENDING_OUTPUT_CHARS && buffer.chunks.length > 0) {
    const excess = buffer.length - MAX_PENDING_OUTPUT_CHARS;
    const first = buffer.chunks[0];
    let drop = Math.min(excess, first.length);
    if (drop < first.length) {
      const nextCodeUnit = first.charCodeAt(drop);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) drop += 1;
    }
    buffer.truncatedChars += drop;
    buffer.length -= drop;
    if (drop === first.length) buffer.chunks.shift();
    else buffer.chunks[0] = first.slice(drop);
  }
}

export function flushPendingOutput(ptyId: number) {
  if (!terminalInstances.has(ptyId)) return;

  const buffered = pendingOutput.get(ptyId);
  if (!buffered) return;

  pendingOutput.delete(ptyId);
  if (buffered.truncatedChars > 0) {
    enqueueTerminalOutput(ptyId, OUTPUT_TRUNCATED_MARKER);
  }
  for (const chunk of buffered.chunks) enqueueTerminalOutput(ptyId, chunk);
}

/** Route one PTY data event to the attached terminal, or hold it until one is. */
export function writeTerminalOutput(ptyId: number, data: string): void {
  if (terminalInstances.has(ptyId)) enqueueTerminalOutput(ptyId, data);
  else appendPendingOutput(ptyId, data);
}
