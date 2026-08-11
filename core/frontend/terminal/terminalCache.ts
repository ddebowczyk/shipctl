import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { TerminalClientModel } from "./terminalClientModel.ts";
import type { TerminalRendererState } from "./terminalRenderer.ts";
import type { SemanticTerminalBinding } from "./terminalSemanticSurface.ts";
import type { TerminalViewSession } from "./terminalViewSession.ts";
import type { TerminalViewportPin } from "./terminalViewportPin.ts";
import type { TerminalAttachmentId, TerminalId } from "./types.ts";

export interface TerminalCacheEntry extends TerminalRendererState {
  term: Terminal;
  fitAddon: FitAddon;
  attachmentId: TerminalAttachmentId | null;
  /** Where the user is reading. Outlives any one view session. */
  viewportPin: TerminalViewportPin;
  /**
   * The live view session's input sink, or null while none is bound. The
   * terminal's own input handlers are installed once, so they submit through
   * this rather than closing over a session that may already be gone.
   */
  inputSink: ((data: string) => void) | null;
}

// Keep terminal instances alive across tab switches.
//
// This lives apart from TerminalView so that the capability's logic never has to
// import a .tsx file: the node --test lanes run through Node's type stripping,
// which handles .ts but not JSX.
export const terminalCache = new Map<TerminalId, TerminalCacheEntry>();

/**
 * The client model of each terminal on the semantic path.
 *
 * The peer of the cache above, and the thing that survives what the cache
 * survives: a tab switch, a surface rebuilt, a renderer swapped. It is kept
 * apart because it is what remains once xterm is gone, and because a model is
 * not an engine — nothing in here is a terminal, only what one is known to be.
 */
const terminalModels = new Map<TerminalId, TerminalClientModel>();

/** The model for one terminal, made on first use and kept until it is closed. */
export function terminalModel(terminalId: TerminalId): TerminalClientModel {
  const existing = terminalModels.get(terminalId);
  if (existing && !existing.disposed) return existing;
  const model = new TerminalClientModel();
  terminalModels.set(terminalId, model);
  return model;
}

/** Forget one terminal's model. The terminal is gone, not merely hidden. */
export function disposeTerminalModel(terminalId: TerminalId): void {
  terminalModels.get(terminalId)?.dispose();
  terminalModels.delete(terminalId);
}

/**
 * The live presentation of each terminal on the semantic path.
 *
 * Kept for the reason the xterm engine above is kept: a tab switch starts a new
 * view session, and building a second canvas, a second presenter and a second
 * set of listeners for a terminal that already has them would leak the first
 * and paint from both. What the presentation is built over — the model — is
 * cached separately, because it outlives even this.
 */
const terminalPresentations = new Map<TerminalId, SemanticTerminalBinding>();

/** The presentation for one terminal, or null while it has none. */
export function terminalPresentation(terminalId: TerminalId): SemanticTerminalBinding | null {
  return terminalPresentations.get(terminalId) ?? null;
}

export function setTerminalPresentation(
  terminalId: TerminalId,
  binding: SemanticTerminalBinding,
): void {
  terminalPresentations.set(terminalId, binding);
}

/** Tear down one terminal's pixels. The model is untouched. */
export function disposeTerminalPresentation(terminalId: TerminalId): void {
  terminalPresentations.get(terminalId)?.dispose();
  terminalPresentations.delete(terminalId);
}

/**
 * The live view session of each terminal displayed on the semantic path.
 *
 * Only that path: the byte path's terminals are reached through the engines
 * above, which is where their theme and font live. A session is registered by
 * the composition root that built it and forgotten when the view that holds it
 * ends, so what is in here is exactly what a global change — a new theme, a new
 * font — has to be told about while it is on screen.
 */
const terminalSessions = new Map<TerminalId, TerminalViewSession>();

export function setTerminalSession(terminalId: TerminalId, session: TerminalViewSession): void {
  terminalSessions.set(terminalId, session);
}

export function forgetTerminalSession(terminalId: TerminalId): void {
  terminalSessions.delete(terminalId);
}

/** Every semantic terminal on screen now. */
export function liveTerminalSessions(): readonly TerminalViewSession[] {
  return [...terminalSessions.values()];
}
