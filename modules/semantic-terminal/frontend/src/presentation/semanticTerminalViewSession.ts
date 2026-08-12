/**
 * A displayed semantic terminal.
 *
 * This is the semantic presentation lifetime: it joins the module-owned
 * attachment protocol to a surface, keeps its viewport readable, and fits it
 * to its container. The host supplies operations through typed ports; it does
 * not supply a second terminal protocol.
 */

import {
  SemanticTerminalAttachmentController,
  type SemanticTerminalAttachmentLease,
} from "./semanticTerminalAttachmentController.ts";
import { TerminalClientModel } from "./terminalClientModel.ts";
import { clampTerminalGeometry, type TerminalGeometry } from "./terminalFitPlan.ts";
import { TerminalFitScheduler } from "./terminalFitScheduler.ts";
import type { TerminalInput } from "./terminalSemanticInput.ts";
import { TerminalReadingAnchor } from "./terminalReadingAnchor.ts";
import type { TerminalSurface } from "./terminalSurface.ts";
import type { TerminalViewportPin } from "./terminalViewportPin.ts";
import {
  requiredHistoryWindow,
  type TerminalHistoryRequest,
} from "./terminalViewportComposition.ts";
import type {
  SemanticTerminalWireEvent,
  TerminalAnchorId,
  TerminalEffect,
  TerminalInputOutcome,
  TerminalProjectedPoint,
  TerminalProjectedSpace,
} from "../semanticTypes.ts";

export interface SemanticTerminalSessionAnchors {
  anchor(space: TerminalProjectedSpace, at: TerminalProjectedPoint): Promise<unknown>;
  resolveAnchor(anchor: TerminalAnchorId): Promise<unknown>;
  releaseAnchor(anchor: TerminalAnchorId): Promise<unknown>;
}

/** The host operations this semantic presentation needs. */
export interface SemanticTerminalSessionRuntime {
  attach(
    onEvent: (event: SemanticTerminalWireEvent) => void,
  ): Promise<SemanticTerminalAttachmentLease>;
  detach(attachmentId: string): Promise<void>;
  creditScreen(attachmentId: string, committedSequence: number): Promise<void>;
  acceptsInput(): boolean;
  sendInput(input: TerminalInput): Promise<TerminalInputOutcome>;
  readHistory(startRow: number, rows: number): Promise<unknown>;
  anchors?: SemanticTerminalSessionAnchors;
  resize(attachmentId: string, size: TerminalGeometry): Promise<void>;
  recordModelCommit?(milliseconds: number): void;
}

export interface SemanticTerminalSessionTiming {
  nextFrame(): Promise<void>;
  defer(task: () => void, delayMs: number): () => void;
  fontsReady(): Promise<void> | null;
}

export interface SemanticTerminalViewSessionPorts {
  surface: TerminalSurface;
  runtime: SemanticTerminalSessionRuntime;
  timing: SemanticTerminalSessionTiming;
  /** The durable model. It outlives any one visible presentation. */
  model: TerminalClientModel;
  reportEffect?(effect: TerminalEffect): void;
  recordDiagnostic?(
    event: string,
    facts?: Readonly<Record<string, string | number | boolean | null>>,
  ): void;
  notifyError(title: string, error: unknown): void;
}

/** The host shell uses this structural shape for all terminal presentations. */
export interface TerminalDisplaySession {
  readonly pin: TerminalViewportPin;
  reveal(): void;
  conceal(): void;
  requestFit(): Promise<void>;
  applyTheme(): void;
  applySettings(): void;
  dispose(): void;
}

const REVEAL_SETTLE_MS = 100;

type TerminalDiagnosticFacts = Readonly<
  Record<string, string | number | boolean | null>
>;

/**
 * Describe one input without retaining text or paste contents.
 *
 * A modified or named key keeps its physical code so Ctrl+C, Ctrl+Z, arrows,
 * and function keys remain distinguishable in a failed runtime trace. A plain
 * printable key is identified only as `text_key`, so commands and secrets do
 * not enter the release log.
 */
export function semanticInputDiagnosticFacts(input: TerminalInput): TerminalDiagnosticFacts {
  if (input.kind === "key") {
    const modified = input.mods.ctrl || input.mods.alt || input.mods.meta;
    const keyClass = input.composing
      ? "composing_key"
      : modified
        ? "modified_key"
        : input.text === null
          ? "named_key"
          : "text_key";
    return {
      kind: input.kind,
      action: input.action,
      keyClass,
      ...(modified || input.text === null ? { code: input.code } : {}),
      shift: input.mods.shift,
      alt: input.mods.alt,
      ctrl: input.mods.ctrl,
      meta: input.mods.meta,
      capsLock: input.mods.capsLock,
      numLock: input.mods.numLock,
      composing: input.composing,
    };
  }
  if (input.kind === "mouse") {
    return {
      kind: input.kind,
      action: input.action,
      button: input.button,
      anyButtonPressed: input.anyButtonPressed,
      shift: input.mods.shift,
      alt: input.mods.alt,
      ctrl: input.mods.ctrl,
      meta: input.mods.meta,
    };
  }
  if (input.kind === "focus") {
    return { kind: input.kind, gained: input.gained };
  }
  return { kind: input.kind };
}

export class SemanticTerminalViewSession implements TerminalDisplaySession {
  readonly #ports: SemanticTerminalViewSessionPorts;
  readonly #controller: SemanticTerminalAttachmentController;
  readonly #fit: TerminalFitScheduler;
  readonly #reading: TerminalReadingAnchor | null;
  #cancelSettle: (() => void) | null = null;
  #unwatchModel: (() => void) | null = null;
  #readingHistory: TerminalHistoryRequest | null = null;
  #historyRead: { request: TerminalHistoryRequest; sequence: number } | null = null;
  #lastInputFailure: string | null = null;
  #revealGeneration = 0;
  #visible = false;
  #disposed = false;

  constructor(ports: SemanticTerminalViewSessionPorts) {
    this.#ports = ports;
    const anchors = ports.runtime.anchors;
    this.#reading = anchors
      ? new TerminalReadingAnchor({
          anchor: (space, at) => anchors.anchor(space, at),
          resolveAnchor: (anchor) => anchors.resolveAnchor(anchor),
          releaseAnchor: (anchor) => anchors.releaseAnchor(anchor),
          intent: () => ports.model.viewportIntent,
          setIntent: (intent) => ports.model.setViewportIntent(intent),
          notifyError: (title, error) => ports.notifyError(title, error),
        })
      : null;
    this.#fit = new TerminalFitScheduler({
      measure: () => {
        const proposed = ports.surface.proposeGeometry();
        return proposed
          ? { current: ports.surface.geometry(), proposed, bufferRows: ports.surface.bufferRows() }
          : null;
      },
      applySize: (size) => this.#applySize(size),
      defer: (task, delayMs) => ports.timing.defer(task, delayMs),
    });
    this.#controller = new SemanticTerminalAttachmentController({
      attach: (onEvent) => ports.runtime.attach(onEvent),
      detach: (attachmentId) => ports.runtime.detach(attachmentId),
      creditScreen: (attachmentId, sequence) => ports.runtime.creditScreen(attachmentId, sequence),
      acceptsInput: () => ports.runtime.acceptsInput(),
      sendInput: (input) => ports.runtime.sendInput(input),
      readHistory: (startRow, rows) => ports.runtime.readHistory(startRow, rows),
      publishAttachmentId: (attachmentId) => ports.surface.publishAttachmentId(attachmentId),
      reportError: (error) => {
        if (import.meta.env?.DEV) console.error("Failed to attach terminal renderer:", error);
        ports.notifyError("Couldn’t attach terminal", error);
      },
      reportRawEvent: (error) => ports.notifyError("Couldn’t show terminal output", error),
      reportState: (event, facts) => ports.recordDiagnostic?.(event, facts),
      model: ports.model,
      recordModelCommit: ports.runtime.recordModelCommit,
    });
  }

  get pin(): TerminalViewportPin {
    return this.#ports.surface.pin;
  }

  start(): void {
    this.#ports.surface.open();
    this.#ports.surface.setInputSink(null);
    this.#ports.surface.setSemanticInputSink?.((input) => this.#submitInput(input));
    this.#unwatchModel = this.#ports.model.subscribe(() => {
      this.#reading?.observe();
      this.#readDisplayedHistory();
      this.#reportEffects();
    });
    this.reveal();
  }

  reveal(): void {
    if (this.#disposed) return;
    this.#visible = true;
    const generation = ++this.#revealGeneration;
    this.#ports.recordDiagnostic?.("view_revealed");
    this.#ports.surface.setVisible?.(true);
    this.#controller.setScreenDemand(true);
    void this.#reveal(generation);
  }

  conceal(): void {
    if (this.#disposed) return;
    this.#visible = false;
    this.#revealGeneration += 1;
    this.#ports.recordDiagnostic?.("view_concealed");
    this.#cancelSettle?.();
    this.#cancelSettle = null;
    this.#ports.surface.setVisible?.(false);
    this.#controller.setScreenDemand(false);
  }

  requestFit(): Promise<void> {
    return this.#fit.request();
  }

  applyTheme(): void {
    if (!this.#disposed) this.#ports.surface.applyCurrentTheme();
  }

  applySettings(): void {
    if (this.#disposed) return;
    this.#ports.surface.applyCurrentSettings();
    void this.#fit.request();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#visible = false;
    this.#revealGeneration += 1;
    this.#ports.recordDiagnostic?.("view_disposed");
    this.#ports.surface.setInputSink(null);
    this.#ports.surface.setSemanticInputSink?.(null);
    this.#unwatchModel?.();
    this.#unwatchModel = null;
    this.#reading?.dispose();
    this.#controller.dispose();
    this.#fit.dispose();
    this.#cancelSettle?.();
    this.#cancelSettle = null;
  }

  #reportEffects(): void {
    if (!this.#ports.reportEffect) return;
    for (const effect of this.#ports.model.drainEffects()) this.#ports.reportEffect(effect);
  }

  #isCurrentReveal(generation: number): boolean {
    return !this.#disposed && this.#visible && this.#revealGeneration === generation;
  }

  async #reveal(generation: number): Promise<void> {
    const { surface, timing } = this.#ports;
    this.#cancelSettle?.();
    this.#cancelSettle = null;
    await timing.nextFrame();
    if (!this.#isCurrentReveal(generation)) return;
    surface.applyCurrentTheme();
    surface.applyCurrentSettings();
    surface.refresh();
    await this.#fit.request();
    if (!this.#isCurrentReveal(generation)) return;
    surface.resyncViewport();
    await this.#controller.start();
    if (!this.#isCurrentReveal(generation)) return;
    await this.#fit.request();
    if (!this.#isCurrentReveal(generation)) return;
    this.#cancelSettle = timing.defer(() => {
      if (!this.#isCurrentReveal(generation)) return;
      void this.#fit.request();
      surface.focus();
      this.#ports.recordDiagnostic?.("view_focused");
    }, REVEAL_SETTLE_MS);
    void timing.fontsReady()?.then(() => {
      if (!this.#isCurrentReveal(generation)) return;
      void this.#fit.request();
      surface.logActiveFont();
    });
  }

  #submitInput(input: TerminalInput): void {
    this.#ports.recordDiagnostic?.("input_observed", semanticInputDiagnosticFacts(input));
    void this.#controller.submitInput(input).then((outcome) => this.#noteInput(outcome));
  }

  #readDisplayedHistory(): void {
    const { model } = this.#ports;
    const state = model.state;
    if (this.#disposed || !state || this.#readingHistory) return;
    const wanted = requiredHistoryWindow(state.screen, model.viewportIntent, model.history);
    if (!wanted) return;
    const last = this.#historyRead;
    if (last && last.sequence === state.sequence && last.request.startRow === wanted.startRow
      && last.request.rows === wanted.rows) return;
    this.#readingHistory = wanted;
    this.#historyRead = { request: wanted, sequence: state.sequence };
    void this.#controller.readHistory(wanted.startRow, wanted.rows).then((outcome) => {
      this.#readingHistory = null;
      if (this.#disposed) return;
      if (outcome.status === "committed") {
        this.#readDisplayedHistory();
        return;
      }
      this.#ports.notifyError("Couldn’t read terminal history", new Error(outcome.detail ?? outcome.reason));
    }).catch((error: unknown) => {
      this.#readingHistory = null;
      if (!this.#disposed) this.#ports.notifyError("Couldn’t read terminal history", error);
    });
  }

  #noteInput(outcome: TerminalInputOutcome): void {
    this.#ports.recordDiagnostic?.("input_result", {
      status: outcome.status,
      ...(outcome.status === "accepted" ? { encodedBytes: outcome.encodedBytes } : {}),
      ...(outcome.status === "unavailable" ? { reason: outcome.reason } : {}),
    });
    if (this.#disposed || outcome.status === "unavailable") {
      this.#lastInputFailure = null;
      return;
    }
    if (outcome.status === "accepted") {
      this.#lastInputFailure = null;
      this.#ports.surface.pin.noteInputAccepted();
      return;
    }
    const failure = String(outcome.error);
    if (failure === this.#lastInputFailure) return;
    this.#lastInputFailure = failure;
    if (import.meta.env?.DEV) console.error("Failed to write terminal input:", outcome.error);
    this.#ports.notifyError("Couldn’t write to terminal", outcome.error);
  }

  async #applySize(geometry: TerminalGeometry): Promise<void> {
    const { surface, runtime } = this.#ports;
    const size = clampTerminalGeometry(geometry);
    const current = surface.geometry();
    if (current.columns === size.columns && current.rows === size.rows) return;
    surface.resizePreservingViewport(size);
    const attachmentId = this.#controller.attachmentId;
    if (!attachmentId) return;
    await runtime.resize(attachmentId, size).catch((error: unknown) => {
      if (import.meta.env?.DEV) console.error("Failed to resize PTY:", error);
    });
  }
}

export function startSemanticTerminalViewSession(
  ports: SemanticTerminalViewSessionPorts,
): SemanticTerminalViewSession {
  const session = new SemanticTerminalViewSession(ports);
  session.start();
  return session;
}
