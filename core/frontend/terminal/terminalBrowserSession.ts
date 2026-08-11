/**
 * The browser composition root for a terminal view session.
 *
 * Every port the session names is bound here to the thing that really performs
 * it: a surface for the pixels, the client runtime for the host, the platform
 * for time, the notice store for failures. Nothing decides anything — that is
 * the point of the file, and the reason the session itself has no browser in
 * it.
 *
 * One decision does live here, and only one: which transport a terminal is
 * displayed on. `legacy` binds xterm, the output queue and the byte path;
 * `semantic` binds the client model, the presenter and the canvas. It is the
 * webview's half of `TerminalTransport`, it is stated at exactly one call site,
 * and area 05 deletes the argument along with everything the first branch
 * names.
 */

import { getErrorMessage, openUrl } from "@shipctl/core/platform";
import { useNoticeStore } from "@shipctl/core/shared";
import {
  disposeTerminalModel,
  disposeTerminalPresentation,
  forgetTerminalSession,
  setTerminalPresentation,
  setTerminalSession,
  terminalModel,
  terminalPresentation,
} from "./terminalCache.ts";
import type { TerminalClientModel } from "./terminalClientModel.ts";
import { TERMINAL_CLIENT_RUNTIME } from "./terminalClientRuntime.ts";
import { notifyAgent } from "./notifications.ts";
import {
  observeGesturesWithListeners,
  observeResizeWithObserver,
  type TerminalContainerPorts,
} from "./terminalContainerBinding.ts";
import {
  bindSemanticTerminal,
  type SemanticTerminalBinding,
  type SemanticTerminalBindingPorts,
} from "./terminalSemanticSurface.ts";
import {
  startTerminalViewSession,
  type TerminalViewSession,
  type TerminalViewSessionPorts,
} from "./terminalViewSession.ts";
import { bindXtermTerminal, disposeXtermTerminal } from "./terminalXtermSurface.ts";
import type { TerminalId, TerminalTransport } from "./types.ts";

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

/**
 * The transport the webview displays terminals on.
 *
 * Stated once, as a value rather than a condition, so that the day it becomes
 * `semantic` is one edit and the day area 05 lands is a deletion. This is that
 * edit. Everything a person does to a terminal — typing, composing, pasting,
 * selecting with a pointer or a keyboard, following a link, scrolling back,
 * dragging past the edge, the wheel, mouse reporting — now reaches the host as
 * meaning, and every pixel is painted from what the host answered.
 *
 * What is not settled by flipping it is what only a running app can settle:
 * the register's manual entries, and the measurement the register calls
 * `measure.sustained-output`. The value above is what makes both observable,
 * and it is one word to put back. The second VT stays until they are read.
 */
export const WEBVIEW_TERMINAL_TRANSPORT: TerminalTransport = "semantic";

function notifyError(title: string, error: unknown): void {
  useNoticeStore.getState().pushNotice({
    tone: "error",
    title,
    message: getErrorMessage(error),
  });
}

/**
 * One terminal's presentation, built once and moved between containers.
 *
 * A hidden tab shown again starts a new view session around the same terminal.
 * Building a second canvas for it would leak the first and paint from both, so
 * the presentation is cached beside the model and re-parented instead — the
 * same reuse the xterm engine gets from being opened into a new element.
 */
function bindOrReusePresentation(
  terminalId: TerminalId,
  model: TerminalClientModel,
  container: HTMLElement,
  ports: SemanticTerminalBindingPorts,
): SemanticTerminalBinding {
  const held = terminalPresentation(terminalId);
  if (held && held.model === model) {
    held.attachTo(container);
    return held;
  }
  // A model that was replaced took its presentation's reason to exist with it.
  disposeTerminalPresentation(terminalId);
  const binding = bindSemanticTerminal(model, container, ports);
  setTerminalPresentation(terminalId, binding);
  return binding;
}

export function createBrowserTerminalSessionPorts(
  terminalId: TerminalId,
  container: HTMLElement,
  transport: TerminalTransport = WEBVIEW_TERMINAL_TRANSPORT,
): TerminalViewSessionPorts {
  const host = {
    detach: (attachmentId: Parameters<typeof TERMINAL_CLIENT_RUNTIME.detach>[0]) =>
      TERMINAL_CLIENT_RUNTIME.detach(attachmentId),
    observeDescriptor: (descriptor: Parameters<
      typeof TERMINAL_CLIENT_RUNTIME.observeDescriptor
    >[0]) => {
      TERMINAL_CLIENT_RUNTIME.observeDescriptor(descriptor);
    },
    acceptsInput: () => TERMINAL_CLIENT_RUNTIME.descriptor(terminalId)?.lifecycle === "running",
    resize: (
      attachmentId: Parameters<typeof TERMINAL_CLIENT_RUNTIME.resize>[1],
      size: { columns: number; rows: number },
    ) => TERMINAL_CLIENT_RUNTIME.resize(terminalId, attachmentId, size.columns, size.rows),
  };

  if (transport === "semantic") {
    const model = terminalModel(terminalId);
    const { surface } = bindOrReusePresentation(terminalId, model, container, {
      // The host answers with the selected text as well as the state, and the
      // cells it marked arrive in the next frame. Nothing here holds either:
      // the selection is the host's, and the answer goes straight back to the
      // surface, which puts the text where a copy gesture will find it.
      select: (request) =>
        TERMINAL_CLIENT_RUNTIME.select(terminalId, request).catch((error: unknown) => {
          notifyError("Terminal selection failed", error);
          return null;
        }),
      openLink: (uri) => {
        void openUrl(uri).catch((error: unknown) => {
          notifyError("Could not open the link", error);
        });
      },
    });
    return {
      surface,
      model,
      runtime: {
        attach: (onEvent) => TERMINAL_CLIENT_RUNTIME.attach(terminalId, true, onEvent, "semantic"),
        ...host,
        // Present because the session's interface names it, and unreachable:
        // this surface produces no bytes for it to carry.
        write: () =>
          Promise.resolve({
            status: "failed" as const,
            error: new Error("This terminal sends input as meaning, not bytes"),
          }),
        sendInput: (input) => TERMINAL_CLIENT_RUNTIME.input(terminalId, input),
        readHistory: (startRow, rows) =>
          TERMINAL_CLIENT_RUNTIME.history(terminalId, startRow, rows),
        anchors: {
          anchor: (space, at) => TERMINAL_CLIENT_RUNTIME.anchor(terminalId, space, at),
          resolveAnchor: (anchor) => TERMINAL_CLIENT_RUNTIME.resolveAnchor(terminalId, anchor),
          releaseAnchor: (anchor) => TERMINAL_CLIENT_RUNTIME.releaseAnchor(terminalId, anchor),
        },
      },
      timing: BROWSER_TIMING,
      // A bell is the child asking for attention, and it reaches the same
      // notification the byte path raises from xterm's own bell. The rest of
      // what the host reports beside the screen has no client on this path
      // yet: a title reaches the chrome through the descriptor whatever the
      // transport, and a clipboard write is an owner decision (see the
      // register's effect.clipboard-write).
      reportEffect: (effect) => {
        if (effect.kind === "bell") void notifyAgent(terminalId, "Terminal bell");
      },
      notifyError,
    };
  }

  const { surface, output } = bindXtermTerminal(terminalId, container);
  return {
    surface,
    output,
    runtime: {
      // Legacy while xterm owns this surface: it interprets the child's bytes.
      attach: (onEvent) => TERMINAL_CLIENT_RUNTIME.attach(terminalId, true, onEvent, "legacy"),
      ...host,
      write: (data) => TERMINAL_CLIENT_RUNTIME.write(terminalId, data),
    },
    timing: BROWSER_TIMING,
    notifyError,
  };
}

/** Display one terminal in one container until the returned session is disposed. */
export function startBrowserTerminalSession(
  terminalId: TerminalId,
  container: HTMLElement,
): TerminalViewSession {
  const session = startTerminalViewSession(
    createBrowserTerminalSessionPorts(terminalId, container),
  );
  // A terminal with a presentation is a terminal on the semantic path, and its
  // theme and font are the session's to re-read: there is no engine in the
  // cache for the global appliers to reach instead.
  if (terminalPresentation(terminalId)) setTerminalSession(terminalId, session);
  return session;
}

/**
 * The browser bindings for one terminal's container.
 *
 * The view calls this and nothing else: every DOM API the terminal needs is
 * named here, so the binding's own logic stays provable without one.
 */
export function createBrowserContainerPorts(
  terminalId: TerminalId,
): TerminalContainerPorts {
  return {
    startSession: (container) => startBrowserTerminalSession(terminalId, container),
    disposeEngine: () => {
      // The terminal is gone, not hidden, so both of the things that outlive a
      // session end here: the engine on one transport, the presentation and
      // the model on the other. The session itself was disposed a moment ago,
      // by the binding that called this.
      forgetTerminalSession(terminalId);
      disposeXtermTerminal(terminalId);
      disposeTerminalPresentation(terminalId);
      disposeTerminalModel(terminalId);
    },
    observeResize: observeResizeWithObserver,
    observeGestures: observeGesturesWithListeners,
  };
}
