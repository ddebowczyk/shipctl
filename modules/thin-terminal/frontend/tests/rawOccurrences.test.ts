import assert from "node:assert/strict";
import test from "node:test";

import { writeRawTerminalOccurrences } from "../src/rawOccurrences.ts";

test("thin terminal forwards each raw occurrence with byte identity", async () => {
  const first = new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d]);
  const second = new Uint8Array([0x00, 0xff, 0x0a]);
  const received: Uint8Array[] = [];

  async function* occurrences() {
    yield { sequence: 41, bytes: first };
    yield { sequence: 42, bytes: second };
  }

  await writeRawTerminalOccurrences(occurrences(), (bytes) => received.push(bytes), () => false);

  assert.deepEqual(received, [first, second]);
  assert.equal(received[0], first);
  assert.equal(received[1], second);
});
