/**
 * The browser composition root for a terminal view session.
 *
 * Every port the session names is bound here to the thing that really performs
 * it: xterm for the surface, the output queue for bytes, the client runtime for
 * the host, the platform for time, the notice store for failures. Nothing
 * decides anything — that is the point of the file, and the reason the session
 * itself has no browser in it.
 */

import { getErrorMessage } from "@shipctl/core/platform";
import { useNoticeStore } from "@shipctl/core/shared";
import { TERMINAL_CLIENT_RUNTIME } from "./terminalClientRuntime.ts";
import {
  startTerminalViewSession,
  type TerminalViewSession,
  type TerminalViewSessionPorts,
} from "./terminalViewSession.ts";
import { bindXtermTerminal } from "./terminalXtermSurface.ts";
import type { TerminalId } from "./types.ts";

const BROWSER_TIMING: TerminalViewSessionPorts["timing"] = {
  nextFrame: () =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    }),
  defer: (task, delayMs) => {
    const handle = window.setTimeout(task, delayMs);
    return () => window.clearTimeout(handle);
  },
  // A platform without the Font Loading API gives no signal to wait for, and
  // the reveal simply keeps the metrics it measured.
  fontsReady: () => ("fonts" in document ? document.fonts.ready.then(() => undefined) : null),
};

export function createBrowserTerminalSessionPorts(
  terminalId: TerminalId,
  container: HTMLElement,
): TerminalViewSessionPorts {
  const { surface, output } = bindXtermTerminal(terminalId, container);

  return {
    surface,
    output,
    runtime: {
      attach: (onEvent) => TERMINAL_CLIENT_RUNTIME.attach(terminalId, true, onEvent),
      detach: (attachmentId) => TERMINAL_CLIENT_RUNTIME.detach(attachmentId),
      observeDescriptor: (descriptor) => {
        TERMINAL_CLIENT_RUNTIME.observeDescriptor(descriptor);
      },
      write: (data) => TERMINAL_CLIENT_RUNTIME.write(terminalId, data),
      acceptsInput: () =>
        TERMINAL_CLIENT_RUNTIME.descriptor(terminalId)?.lifecycle === "running",
      resize: (attachmentId, size) =>
        TERMINAL_CLIENT_RUNTIME.resize(terminalId, attachmentId, size.columns, size.rows),
    },
    timing: BROWSER_TIMING,
    notifyError: (title, error) => {
      useNoticeStore.getState().pushNotice({
        tone: "error",
        title,
        message: getErrorMessage(error),
      });
    },
  };
}

/** Display one terminal in one container until the returned session is disposed. */
export function startBrowserTerminalSession(
  terminalId: TerminalId,
  container: HTMLElement,
): TerminalViewSession {
  return startTerminalViewSession(
    createBrowserTerminalSessionPorts(terminalId, container),
  );
}
