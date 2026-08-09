import type { TerminalTabData } from "@shipctl/core/platform";

/**
 * Blank shells are the only terminal tabs whose successful natural completion
 * is a convenience-close. Module-owned sessions and saved commands preserve
 * their own output and lifecycle semantics.
 */
export function shouldAutoCloseBlankTerminal(
  tab: TerminalTabData | undefined,
  exitCode: number,
): boolean {
  return exitCode === 0 && tab?.moduleSessionId === undefined && tab?.commandName === null;
}
