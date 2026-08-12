/** Clipboard gestures and actions owned by the semantic terminal surface. */

export type TerminalClipboardAction = "copy" | "paste";

/**
 * Return the browser clipboard action for a terminal key event.
 *
 * Command-C and Command-V belong to the focused textarea on macOS. They must
 * not become terminal key input, and their browser default must remain intact
 * so the platform can dispatch copy or paste. Plain Control-C still belongs to
 * the child process.
 */
export function terminalClipboardShortcut(
  event: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey">,
): TerminalClipboardAction | null {
  if (!event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.code === "KeyC") return "copy";
  if (event.code === "KeyV") return "paste";
  return null;
}

export interface TerminalClipboardPorts {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
  reviewPaste(text: string, submit: () => void): void;
  submitPaste(text: string): void;
  unavailable(action: TerminalClipboardAction, error: unknown): void;
}

/** Read and submit one context-menu paste. */
export async function pasteFromTerminalClipboard(ports: TerminalClipboardPorts): Promise<void> {
  try {
    const text = await ports.readText();
    if (text) ports.reviewPaste(text, () => ports.submitPaste(text));
  } catch (error: unknown) {
    ports.unavailable("paste", error);
  }
}

/** Write the current host selection for one context-menu copy. */
export async function copyToTerminalClipboard(
  text: string,
  ports: TerminalClipboardPorts,
): Promise<void> {
  if (!text) return;
  try {
    await ports.writeText(text);
  } catch (error: unknown) {
    ports.unavailable("copy", error);
  }
}
