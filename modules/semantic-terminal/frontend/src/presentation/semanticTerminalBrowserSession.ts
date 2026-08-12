/** Browser composition for one module-owned semantic terminal. */

import type { ModuleTerminalPresentationPort } from "@shipctl/module-api";

import {
  anchorSemanticTerminal,
  attachSemanticTerminal,
  creditSemanticTerminalScreen,
  detachSemanticTerminal,
  historySemanticTerminal,
  inputSemanticTerminal,
  isSemanticTerminalPasteSafe,
  releaseSemanticTerminalAnchor,
  resolveSemanticTerminalAnchor,
  resizeSemanticTerminal,
  selectSemanticTerminal,
} from "../protocol/semanticTerminalClient.ts";
import { reportTerminalEffectOutcome, reviewTerminalPaste } from "../browserInteraction.ts";
import type { TerminalInputOutcome } from "../semanticTypes.ts";
import {
  disposeTerminalModel,
  disposeTerminalPresentation,
  forgetTerminalSession,
  setTerminalPresentation,
  setTerminalSession,
  terminalModel,
  terminalPresentation,
} from "./terminalCache.ts";
import {
  bindSemanticTerminal,
  type SemanticTerminalBinding,
  type SemanticTerminalBindingPorts,
} from "./semanticTerminalCanvasBinding.ts";
import {
  startSemanticTerminalViewSession,
  type SemanticTerminalViewSessionPorts,
  type TerminalDisplaySession,
} from "./semanticTerminalViewSession.ts";
import {
  observeGesturesWithListeners,
  observeResizeWithObserver,
  type TerminalContainerPorts,
} from "./terminalContainerBinding.ts";
import type { TerminalClientModel } from "./terminalClientModel.ts";
import type { TerminalInput } from "./terminalSemanticInput.ts";

const BROWSER_TIMING: SemanticTerminalViewSessionPorts["timing"] = {
  nextFrame: () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  defer: (task, delayMs) => {
    const handle = window.setTimeout(task, delayMs);
    return () => window.clearTimeout(handle);
  },
  fontsReady: () => ("fonts" in document ? document.fonts.ready.then(() => undefined) : null),
};

const EXPECTED_INPUT_UNAVAILABILITY = new Set(["not_found", "exited", "closing", "shutting_down"]);

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error
    && typeof error.message === "string") return error.message;
  return "Unknown error";
}

async function submitSemanticInput(
  terminalId: string,
  isRunning: () => boolean,
  presentation: ModuleTerminalPresentationPort,
  input: TerminalInput,
): Promise<TerminalInputOutcome> {
  if (!isRunning()) return { status: "unavailable", reason: "exited" };
  try {
    const encodedBytes = await inputSemanticTerminal(terminalId, input);
    return { status: "accepted", encodedBytes };
  } catch (error) {
    const code = presentation.errorCode(error);
    return code && EXPECTED_INPUT_UNAVAILABILITY.has(code)
      ? { status: "unavailable", reason: code }
      : { status: "failed", error };
  }
}

function bindOrReusePresentation(
  terminalId: string,
  model: TerminalClientModel,
  container: HTMLElement,
  presentation: ModuleTerminalPresentationPort,
  ports: SemanticTerminalBindingPorts,
): SemanticTerminalBinding {
  const held = terminalPresentation(terminalId);
  if (held && held.model === model) {
    held.attachTo(container);
    return held;
  }
  disposeTerminalPresentation(terminalId);
  const binding = bindSemanticTerminal(model, container, presentation, ports);
  setTerminalPresentation(terminalId, binding);
  return binding;
}

export interface SemanticTerminalBrowserPorts {
  readonly isRunning: () => boolean;
  readonly notices: {
    push(
      notice: {
        tone: "info" | "error";
        title: string;
        message?: string;
        actions?: readonly {
          label: string;
          variant?: "primary" | "secondary";
          onClick: () => void;
        }[];
      },
      options?: { durationMs?: number },
    ): void;
  };
  readonly externalLinks: { open(url: string): Promise<void> };
  readonly presentation: ModuleTerminalPresentationPort;
}

export function createSemanticTerminalSessionPorts(
  terminalId: string,
  container: HTMLElement,
  ports: SemanticTerminalBrowserPorts,
): SemanticTerminalViewSessionPorts {
  const notify = (title: string, error: unknown) => ports.notices.push({
    tone: "error", title, message: errorMessage(error),
  });
  const model = terminalModel(terminalId);
  const { surface } = bindOrReusePresentation(terminalId, model, container, ports.presentation, {
    select: (request) => selectSemanticTerminal(terminalId, request).catch((error: unknown) => {
      notify("Terminal selection failed", error);
      return null;
    }),
    openLink: (uri) => {
      void ports.externalLinks.open(uri).catch((error: unknown) => notify("Could not open the link", error));
    },
    reviewPaste: (text, submit) => reviewTerminalPaste({
      confirmationEnabled: () => ports.presentation.getSnapshot().confirmUnsafePaste,
      classify: isSemanticTerminalPasteSafe,
      requestConfirmation: (accept, cancel) => ports.notices.push({
        tone: "info",
        title: "Paste multiple lines?",
        message: "The pasted text can execute commands when inserted.",
        actions: [
          { label: "Paste", variant: "primary", onClick: accept },
          { label: "Cancel", variant: "secondary", onClick: cancel },
        ],
      }, { durationMs: 0 }),
      reportFailure: (error) => notify("Could not review terminal paste", error),
    }, text, submit),
    clipboardUnavailable: (action, error) => {
      ports.presentation.recordDiagnostic(terminalId, `clipboard_${action}_failed`, {
        message: errorMessage(error),
      });
      notify(action === "paste" ? "Could not paste into terminal" : "Could not copy terminal text", error);
    },
    rendererUnavailable: (error, retry) => ports.notices.push({
      tone: "error", title: "Terminal renderer failed", message: errorMessage(error),
      actions: [{ label: "Retry", variant: "primary", onClick: retry }],
    }, { durationMs: 0 }),
    recordPaint: (milliseconds) => ports.presentation.recordMetric(terminalId, "paint", milliseconds),
    recordDiagnostic: (event, facts) => {
      ports.presentation.recordDiagnostic(terminalId, event, facts);
    },
  });

  return {
    surface,
    model,
    runtime: {
      attach: (onEvent) => attachSemanticTerminal(
        terminalId,
        true,
        onEvent,
        (milliseconds) => ports.presentation.recordMetric(terminalId, "decode", milliseconds),
      ),
      detach: detachSemanticTerminal,
      creditScreen: creditSemanticTerminalScreen,
      acceptsInput: ports.isRunning,
      sendInput: (input) => submitSemanticInput(terminalId, ports.isRunning, ports.presentation, input),
      readHistory: (startRow, rows) => historySemanticTerminal(terminalId, startRow, rows),
      recordModelCommit: (milliseconds) => ports.presentation.recordMetric(terminalId, "modelCommit", milliseconds),
      resize: (attachmentId, size) => resizeSemanticTerminal(terminalId, attachmentId, size.columns, size.rows),
      anchors: {
        anchor: (space, at) => anchorSemanticTerminal(terminalId, space, at),
        resolveAnchor: (anchor) => resolveSemanticTerminalAnchor(terminalId, anchor),
        releaseAnchor: (anchor) => releaseSemanticTerminalAnchor(terminalId, anchor),
      },
    },
    timing: BROWSER_TIMING,
    reportEffect: (effect) => reportTerminalEffectOutcome(effect, {
      bell: () => ports.presentation.notifyBell(terminalId, "Terminal bell"),
      clipboardRefused: () => ports.notices.push({
        tone: "info",
        title: "Terminal clipboard request not applied",
        message: "The terminal asked Shipctl to change the clipboard. Shipctl refused it.",
      }),
    }),
    recordDiagnostic: (event, facts) => {
      ports.presentation.recordDiagnostic(terminalId, event, facts);
    },
    notifyError: notify,
  };
}

function startSemanticTerminalBrowserSession(
  terminalId: string,
  container: HTMLElement,
  ports: SemanticTerminalBrowserPorts,
): TerminalDisplaySession {
  const session = startSemanticTerminalViewSession(
    createSemanticTerminalSessionPorts(terminalId, container, ports),
  );
  setTerminalSession(terminalId, session);
  return session;
}

export function createSemanticTerminalContainerPorts(
  terminalId: string,
  ports: SemanticTerminalBrowserPorts,
): TerminalContainerPorts {
  return {
    startSession: (container) => startSemanticTerminalBrowserSession(terminalId, container, ports),
    disposeEngine: () => {
      forgetTerminalSession(terminalId);
      disposeTerminalPresentation(terminalId);
      disposeTerminalModel(terminalId);
    },
    observeResize: observeResizeWithObserver,
    observeGestures: observeGesturesWithListeners,
  };
}
