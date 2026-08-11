import type { TerminalEffect } from "./types.ts";

export interface TerminalEffectOutcomePorts {
  bell(): void;
  clipboardRefused(): void;
}

/**
 * Report the browser-visible outcome of a terminal side effect.
 *
 * OSC 52 is deliberately not applied. A terminal process must not change the
 * system clipboard without a browser gesture. The visible refusal also keeps
 * the request from disappearing without an outcome.
 */
export function reportTerminalEffectOutcome(
  effect: TerminalEffect,
  ports: TerminalEffectOutcomePorts,
): void {
  if (effect.kind === "bell") ports.bell();
  if (effect.kind === "clipboard") ports.clipboardRefused();
}
