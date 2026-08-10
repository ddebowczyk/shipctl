/**
 * Attachment bootstrap ordering.
 *
 * Tauri can deliver channel messages before the `attach_terminal` invoke
 * resolves, so the first host events can arrive before the caller holds the
 * attachment they belong to. This buffer holds them, in order, until the caller
 * activates the attachment.
 *
 * It decodes on arrival rather than on release: an event that violates the host
 * contract is rejected at the boundary, not after it has been queued as if it
 * were valid.
 */

import { decodeTerminalEvent } from "./terminalEventDecoder.ts";
import type { TerminalEvent } from "./types.ts";

export interface TerminalAttachmentBootstrap {
  /** Accept one raw channel message. Throws if it violates the contract. */
  deliver: (raw: unknown) => void;
  /** Release buffered events in arrival order and go live. Idempotent. */
  activate: () => void;
}

export function createTerminalAttachmentBootstrap(
  onEvent: (event: TerminalEvent) => void,
): TerminalAttachmentBootstrap {
  const buffered: TerminalEvent[] = [];
  let active = false;

  return {
    deliver(raw) {
      const event = decodeTerminalEvent(raw);
      if (active) onEvent(event);
      else buffered.push(event);
    },
    activate() {
      if (active) return;
      active = true;
      for (const event of buffered.splice(0)) onEvent(event);
    },
  };
}
