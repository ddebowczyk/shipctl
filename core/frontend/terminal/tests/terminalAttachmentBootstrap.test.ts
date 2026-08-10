import assert from "node:assert/strict";
import { test } from "node:test";

import { createTerminalAttachmentBootstrap } from "../terminalAttachmentBootstrap.ts";
import { TerminalEventDecodeError } from "../terminalEventDecoder.ts";
import type { TerminalEvent } from "../types.ts";

function detached(sequence: number): Record<string, unknown> {
  return { event: "detached", sequence, reason: "closed" };
}

test("events delivered before activation arrive in order afterwards", () => {
  const seen: TerminalEvent[] = [];
  const bootstrap = createTerminalAttachmentBootstrap((event) => seen.push(event));

  bootstrap.deliver(detached(1));
  bootstrap.deliver(detached(2));
  assert.equal(seen.length, 0, "nothing may reach client state before activation");

  bootstrap.activate();
  assert.deepEqual(
    seen.map((event) => event.sequence),
    [1, 2],
  );
});

test("events delivered after activation pass straight through", () => {
  const seen: TerminalEvent[] = [];
  const bootstrap = createTerminalAttachmentBootstrap((event) => seen.push(event));

  bootstrap.activate();
  bootstrap.deliver(detached(1));
  assert.deepEqual(
    seen.map((event) => event.sequence),
    [1],
  );
});

test("buffered and live events form one ordered stream", () => {
  const seen: TerminalEvent[] = [];
  const bootstrap = createTerminalAttachmentBootstrap((event) => seen.push(event));

  bootstrap.deliver(detached(1));
  bootstrap.activate();
  bootstrap.deliver(detached(2));
  assert.deepEqual(
    seen.map((event) => event.sequence),
    [1, 2],
  );
});

test("activation is idempotent and never replays", () => {
  const seen: TerminalEvent[] = [];
  const bootstrap = createTerminalAttachmentBootstrap((event) => seen.push(event));

  bootstrap.deliver(detached(1));
  bootstrap.activate();
  bootstrap.activate();
  assert.equal(seen.length, 1);
});

test("an event violating the contract is rejected on arrival, not queued", () => {
  const seen: TerminalEvent[] = [];
  const bootstrap = createTerminalAttachmentBootstrap((event) => seen.push(event));

  assert.throws(() => bootstrap.deliver({ event: "detached" }), TerminalEventDecodeError);
  bootstrap.activate();
  assert.equal(seen.length, 0, "a rejected event may not be released later");
});
