// OSC 9 is how coding agents (Claude Code, Codex, Gemini) raise a desktop
// notification through the terminal. Extracting the payload is string work, so
// it lives here and the view keeps the parser registration.
//
// Two forms reach the handler. xterm strips the introducer and terminator, so
// the handler sees either the bare message or the `2;`-prefixed form that
// several agents emit.

/** Returns the message an OSC 9 payload carries, or null when it carries none.
 *  A payload with nothing after the optional `2;` prefix is not a
 *  notification and must not raise one. */
export function parseOscNotificationMessage(payload: string): string | null {
  const message = payload.startsWith("2;") ? payload.slice(2) : payload;
  return message === "" ? null : message;
}
