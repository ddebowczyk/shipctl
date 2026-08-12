import assert from "node:assert/strict";
import test from "node:test";

import { semanticTerminalAttachmentLease } from "../src/protocol/semanticTerminalAttachment.ts";

test("maps the host driver attachment into the semantic presentation attachment", () => {
  const state = {
    columns: 80,
    rows: 24,
    screen: "ready",
    scrollbackRows: 0,
    cursor: {},
    modes: {},
    colors: {},
    damage: {},
    viewport: [],
    selection: [],
  };
  let activated = false;

  const lease = semanticTerminalAttachmentLease({
    attachmentId: "attachment-1",
    live: true,
    descriptor: { revision: 7 },
    sequenceBoundary: 12,
    snapshot: state,
  }, () => {
    activated = true;
  });

  assert.deepEqual(lease.snapshot, {
    descriptor: { revision: 7 },
    sequenceBoundary: 12,
    state,
  });
  lease.activate();
  assert.equal(activated, true);
});
