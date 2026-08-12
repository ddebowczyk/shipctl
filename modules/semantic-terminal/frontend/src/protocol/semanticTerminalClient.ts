/**
 * Semantic-terminal's browser IPC boundary.
 *
 * These commands name semantic state only. Terminal lifecycle and raw-byte
 * transport remain host concerns, so this client does not import core types.
 */

import { Channel, invoke } from "@tauri-apps/api/core";

import {
  createSemanticTerminalAttachmentBootstrap,
  type TerminalAttachmentBootstrap,
} from "./terminalAttachmentBootstrap.ts";
import {
  semanticTerminalAttachmentLease,
  type SemanticTerminalAttachmentResponse,
} from "./semanticTerminalAttachment.ts";
import type { SemanticTerminalAttachmentLease } from "../presentation/semanticTerminalAttachmentController.ts";
import type { TerminalInput } from "../presentation/terminalSemanticInput.ts";
import type {
  TerminalAnchorId,
  TerminalProjectedPoint,
  TerminalProjectedSpace,
  TerminalSelectionRequest,
  TerminalSelectionState,
} from "../semanticTypes.ts";

export const SEMANTIC_TERMINAL_COMMANDS = {
  snapshot: "plugin:shipctl-semantic-terminal|get_semantic_terminal_snapshot",
  attach: "plugin:shipctl-semantic-terminal|attach_semantic_terminal",
  creditScreen: "plugin:shipctl-semantic-terminal|credit_semantic_terminal_screen",
  detach: "plugin:shipctl-semantic-terminal|detach_semantic_terminal",
  resize: "plugin:shipctl-semantic-terminal|resize_semantic_terminal",
  input: "plugin:shipctl-semantic-terminal|input_semantic_terminal",
  history: "plugin:shipctl-semantic-terminal|history_semantic_terminal",
  anchor: "plugin:shipctl-semantic-terminal|anchor_semantic_terminal",
  resolveAnchor: "plugin:shipctl-semantic-terminal|resolve_semantic_terminal_anchor",
  releaseAnchor: "plugin:shipctl-semantic-terminal|release_semantic_terminal_anchor",
  select: "plugin:shipctl-semantic-terminal|select_semantic_terminal",
  pasteSafety: "plugin:shipctl-semantic-terminal|is_semantic_terminal_paste_safe",
  publicationStats: "plugin:shipctl-semantic-terminal|get_semantic_terminal_publication_stats",
  appMemory: "plugin:shipctl-semantic-terminal|get_semantic_terminal_app_memory",
} as const;

/** Cumulative semantic publication observations from the native host. */
export interface SemanticTerminalPublicationStats {
  readonly ptyReads: number;
  readonly screenChanges: number;
  readonly screenProjections: number;
  readonly screenEncodes: number;
  readonly screenEncodedBytes: number;
  readonly screenRecipientDeliveries: number;
  readonly effectEvents: number;
  readonly effectEncodedBytes: number;
  readonly currentScreenTransactions: number;
  readonly currentScreenBytesQueued: number;
  readonly peakScreenBytesQueued: number;
  readonly currentEffectEventsQueued: number;
  readonly currentEffectBytesQueued: number;
  readonly peakEffectEventsQueued: number;
  readonly peakEffectBytesQueued: number;
}

export function getSemanticTerminalSnapshot(terminalId: string): Promise<unknown> {
  return invoke(SEMANTIC_TERMINAL_COMMANDS.snapshot, { terminalId });
}

export async function attachSemanticTerminal(
  terminalId: string,
  claimsResize: boolean,
  onEvent: Parameters<typeof createSemanticTerminalAttachmentBootstrap>[0],
  observeDecode?: (milliseconds: number) => void,
): Promise<SemanticTerminalAttachmentLease> {
  const bootstrap: TerminalAttachmentBootstrap = createSemanticTerminalAttachmentBootstrap(
    onEvent,
    observeDecode,
  );
  const channel = new Channel<unknown>();
  channel.onmessage = bootstrap.deliver;
  const attachment = await invoke<SemanticTerminalAttachmentResponse>(SEMANTIC_TERMINAL_COMMANDS.attach, {
    terminalId,
    claimsResize,
    onEvent: channel,
  });
  return semanticTerminalAttachmentLease(attachment, bootstrap.activate);
}

export function creditSemanticTerminalScreen(
  attachmentId: string,
  committedSequence: number,
): Promise<void> {
  return invoke(SEMANTIC_TERMINAL_COMMANDS.creditScreen, { attachmentId, committedSequence });
}

export function detachSemanticTerminal(attachmentId: string): Promise<void> {
  return invoke(SEMANTIC_TERMINAL_COMMANDS.detach, { attachmentId });
}

export function resizeSemanticTerminal(
  terminalId: string,
  attachmentId: string,
  columns: number,
  rows: number,
): Promise<void> {
  return invoke(SEMANTIC_TERMINAL_COMMANDS.resize, {
    terminalId,
    attachmentId,
    columns,
    rows,
  });
}

export function inputSemanticTerminal(terminalId: string, input: TerminalInput): Promise<number> {
  return invoke(SEMANTIC_TERMINAL_COMMANDS.input, { terminalId, input });
}

export function historySemanticTerminal(
  terminalId: string,
  startRow: number,
  rows: number,
): Promise<unknown> {
  return invoke(SEMANTIC_TERMINAL_COMMANDS.history, { terminalId, startRow, rows });
}

export function anchorSemanticTerminal(
  terminalId: string,
  space: TerminalProjectedSpace,
  at: TerminalProjectedPoint,
): Promise<unknown> {
  return invoke(SEMANTIC_TERMINAL_COMMANDS.anchor, { terminalId, space, at });
}

export function resolveSemanticTerminalAnchor(
  terminalId: string,
  anchor: TerminalAnchorId,
): Promise<unknown> {
  return invoke(SEMANTIC_TERMINAL_COMMANDS.resolveAnchor, { terminalId, anchor });
}

export function releaseSemanticTerminalAnchor(
  terminalId: string,
  anchor: TerminalAnchorId,
): Promise<unknown> {
  return invoke(SEMANTIC_TERMINAL_COMMANDS.releaseAnchor, { terminalId, anchor });
}

export function selectSemanticTerminal(
  terminalId: string,
  request: TerminalSelectionRequest,
): Promise<TerminalSelectionState> {
  return invoke(SEMANTIC_TERMINAL_COMMANDS.select, { terminalId, request });
}

export function isSemanticTerminalPasteSafe(text: string): Promise<boolean> {
  return invoke(SEMANTIC_TERMINAL_COMMANDS.pasteSafety, { text });
}

/** Cumulative host observations for the module's development-only scenarios. */
export function getSemanticTerminalPublicationStats(
  terminalId: string,
): Promise<SemanticTerminalPublicationStats> {
  return invoke(SEMANTIC_TERMINAL_COMMANDS.publicationStats, { terminalId });
}

/** Process RSS for development-only scenario context. */
export function getSemanticTerminalAppMemory(): Promise<{ appRss: number }> {
  return invoke(SEMANTIC_TERMINAL_COMMANDS.appMemory);
}
