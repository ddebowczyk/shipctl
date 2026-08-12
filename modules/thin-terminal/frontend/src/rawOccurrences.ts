import type { RawTerminalOccurrence } from "@shipctl/module-api";

/**
 * Deliver the host's exact ordered PTY occurrences to the browser terminal.
 * No decoding, framing, or byte conversion belongs in this path.
 */
export async function writeRawTerminalOccurrences(
  occurrences: AsyncIterable<RawTerminalOccurrence>,
  write: (bytes: Uint8Array) => void,
  isDisposed: () => boolean,
): Promise<void> {
  for await (const occurrence of occurrences) {
    if (isDisposed()) return;
    write(occurrence.bytes);
  }
}
