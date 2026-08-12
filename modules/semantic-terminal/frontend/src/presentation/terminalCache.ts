/** Durable semantic presentation state, keyed by the host terminal identity. */

import { forgetTerminalClientPerformanceStats } from "../terminalPerformanceMetrics.ts";
import { TerminalClientModel } from "./terminalClientModel.ts";
import type { SemanticTerminalBinding } from "./semanticTerminalCanvasBinding.ts";
import type { TerminalDisplaySession } from "./semanticTerminalViewSession.ts";

const models = new Map<string, TerminalClientModel>();
const presentations = new Map<string, SemanticTerminalBinding>();
const sessions = new Map<string, TerminalDisplaySession>();

/** The semantic model for one terminal, made once and retained while it lives. */
export function terminalModel(terminalId: string): TerminalClientModel {
  const existing = models.get(terminalId);
  if (existing && !existing.disposed) return existing;
  const model = new TerminalClientModel();
  models.set(terminalId, model);
  return model;
}

/** The terminal is gone, not merely hidden. Remove its semantic state. */
export function disposeTerminalModel(terminalId: string): void {
  presentations.get(terminalId)?.dispose();
  presentations.delete(terminalId);
  sessions.delete(terminalId);
  models.get(terminalId)?.dispose();
  models.delete(terminalId);
  forgetTerminalClientPerformanceStats(terminalId);
}

export function terminalPresentation(terminalId: string): SemanticTerminalBinding | null {
  return presentations.get(terminalId) ?? null;
}

export function setTerminalPresentation(terminalId: string, binding: SemanticTerminalBinding): void {
  presentations.set(terminalId, binding);
}

export function disposeTerminalPresentation(terminalId: string): void {
  presentations.get(terminalId)?.dispose();
  presentations.delete(terminalId);
}

export function setTerminalSession(terminalId: string, session: TerminalDisplaySession): void {
  sessions.set(terminalId, session);
}

export function terminalSession(terminalId: string): TerminalDisplaySession | null {
  return sessions.get(terminalId) ?? null;
}

export function forgetTerminalSession(terminalId: string): void {
  sessions.delete(terminalId);
}
