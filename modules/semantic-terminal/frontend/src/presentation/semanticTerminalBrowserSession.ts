/** Browser composition for one module-owned semantic terminal. */

import {
  SEMANTIC_TERMINALS_ERROR_CODES,
  type ModuleTerminalPresentationPort,
  type SemanticServiceError,
  type SemanticTerminalScreenAttachment,
  type SemanticTerminalsErrorCode,
  type SemanticTerminalsService,
} from "@shipctl/module-api";
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

class SemanticTerminalRequestError extends Error {
  readonly code: SemanticTerminalsErrorCode;

  constructor(error: SemanticServiceError<SemanticTerminalsErrorCode>) {
    super(error.message);
    this.name = "SemanticTerminalRequestError";
    this.code = error.code;
  }
}

async function semanticResult<Value>(
  operation: Promise<{
    readonly result:
      | { readonly ok: true; readonly value: Value }
      | { readonly ok: false; readonly error: SemanticServiceError<SemanticTerminalsErrorCode> };
  }>,
): Promise<Value> {
  const outcome = await operation;
  if (outcome.result.ok) return outcome.result.value;
  throw new SemanticTerminalRequestError(outcome.result.error);
}

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
  semanticTerminals: SemanticTerminalsService,
  input: TerminalInput,
): Promise<TerminalInputOutcome> {
  if (!isRunning()) return { status: "unavailable", reason: "exited" };
  const outcome = await semanticTerminals.input.execute({ terminalId, input });
  if (outcome.result.ok) {
    return { status: "accepted", encodedBytes: outcome.result.value.encodedBytes };
  }
  const { error } = outcome.result;
  const unavailable = error.code === SEMANTIC_TERMINALS_ERROR_CODES.notFound
    || error.code === SEMANTIC_TERMINALS_ERROR_CODES.unavailable
    || error.code === SEMANTIC_TERMINALS_ERROR_CODES.activationDisposed
    || error.code === SEMANTIC_TERMINALS_ERROR_CODES.cancelled;
  return unavailable
    ? { status: "unavailable", reason: error.code }
    : { status: "failed", error: new SemanticTerminalRequestError(error) };
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
  readonly semanticTerminals: SemanticTerminalsService;
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
  const attachments = new Map<string, {
    readonly attachment: SemanticTerminalScreenAttachment;
    readonly baselineRevision: number;
  }>();
  const { surface } = bindOrReusePresentation(terminalId, model, container, ports.presentation, {
    select: (request) => semanticResult(ports.semanticTerminals.select.execute({
      terminalId,
      request,
    })).catch((error: unknown) => {
      notify("Terminal selection failed", error);
      return null;
    }),
    openLink: (uri) => {
      void ports.externalLinks.open(uri).catch((error: unknown) => notify("Could not open the link", error));
    },
    reviewPaste: (text, submit) => reviewTerminalPaste({
      confirmationEnabled: () => ports.presentation.getSnapshot().confirmUnsafePaste,
      classify: (text) => semanticResult(
        ports.semanticTerminals.inspectPaste.execute({ text }),
      ).then(({ safe }) => safe),
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
      attach: async (onEvent) => {
        let lastSequence = 0;
        const attachment = await ports.semanticTerminals.screens.attach({
          terminalId,
          claimsResize: true,
          afterSequence: null,
          initialCredit: 0,
        }, (delivery) => {
          if (delivery.type === "frame") {
            lastSequence = delivery.sequence;
            if (delivery.value.effects.length > 0) {
              onEvent({
                event: "effects",
                sequence: delivery.sequence,
                effects: delivery.value.effects,
              });
            }
            onEvent({
              event: "screen",
              sequence: delivery.sequence,
              revision: delivery.value.revision,
              state: delivery.value.state,
            });
            return;
          }
          if (delivery.type === "gap") {
            lastSequence = delivery.earliestAvailableSequence;
            onEvent({
              event: "resync_required",
              sequence: delivery.earliestAvailableSequence,
              reason: "semantic screen history is unavailable",
            });
            return;
          }
          if (delivery.resumable) {
            onEvent({
              event: "resync_required",
              sequence: lastSequence,
              reason: delivery.reason,
            });
          } else {
            onEvent({ event: "exited", sequence: lastSequence });
          }
        });
        lastSequence = attachment.snapshot.revision;
        attachments.set(attachment.id, {
          attachment,
          baselineRevision: attachment.snapshot.revision,
        });
        return {
          attachmentId: attachment.id,
          live: attachment.live,
          snapshot: {
            descriptor: { revision: attachment.snapshot.revision },
            sequenceBoundary: attachment.snapshot.revision,
            state: attachment.snapshot.state,
          },
          activate: () => attachment.activate(),
        };
      },
      detach: async (attachmentId) => {
        const held = attachments.get(attachmentId);
        attachments.delete(attachmentId);
        await held?.attachment.dispose();
      },
      creditScreen: async (attachmentId, committedSequence) => {
        const held = attachments.get(attachmentId);
        if (!held) throw new Error(`Semantic terminal attachment ${attachmentId} is unavailable`);
        if (committedSequence !== held.baselineRevision) {
          held.attachment.acknowledge(committedSequence);
        }
        held.attachment.grant(1);
      },
      acceptsInput: ports.isRunning,
      sendInput: (input) => submitSemanticInput(
        terminalId,
        ports.isRunning,
        ports.semanticTerminals,
        input,
      ),
      readHistory: (startRow, rows) => semanticResult(
        ports.semanticTerminals.history.execute({ terminalId, startRow, rows }),
      ),
      recordModelCommit: (milliseconds) => ports.presentation.recordMetric(terminalId, "modelCommit", milliseconds),
      resize: async (attachmentId, size) => {
        const held = attachments.get(attachmentId);
        if (!held) throw new Error(`Semantic terminal attachment ${attachmentId} is unavailable`);
        await semanticResult(ports.semanticTerminals.resize.execute({
          terminalId,
          attachmentId: held.attachment.id,
          columns: size.columns,
          rows: size.rows,
        }));
      },
      anchors: {
        anchor: (space, at) => semanticResult(
          ports.semanticTerminals.createAnchor.execute({ terminalId, space, at }),
        ),
        resolveAnchor: (anchorId) => semanticResult(
          ports.semanticTerminals.resolveAnchor.execute({ terminalId, anchorId }),
        ),
        releaseAnchor: (anchorId) => semanticResult(
          ports.semanticTerminals.releaseAnchor.execute({ terminalId, anchorId }),
        ),
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
