/**
 * Maps the host's generic driver attachment to the semantic presentation
 * attachment. The host owns the descriptor and sequence boundary; the module
 * owns only the opaque semantic snapshot.
 */

import type {
  SemanticTerminalAttachmentLease,
  SemanticTerminalAttachmentSnapshot,
} from "../presentation/semanticTerminalAttachmentController.ts";

export interface SemanticTerminalAttachmentResponse {
  readonly attachmentId: string;
  readonly live: boolean;
  readonly descriptor: SemanticTerminalAttachmentSnapshot["descriptor"];
  readonly sequenceBoundary: number;
  readonly snapshot: SemanticTerminalAttachmentSnapshot["state"];
}

export function semanticTerminalAttachmentLease(
  response: SemanticTerminalAttachmentResponse,
  activate: () => void,
): SemanticTerminalAttachmentLease {
  return {
    attachmentId: response.attachmentId,
    live: response.live,
    snapshot: {
      descriptor: response.descriptor,
      sequenceBoundary: response.sequenceBoundary,
      state: response.snapshot,
    },
    activate,
  };
}
