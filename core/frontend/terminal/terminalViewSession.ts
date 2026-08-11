/**
 * One terminal, displayed.
 *
 * A session binds the attachment protocol to a surface, catches that surface up
 * on everything that changed while it was hidden, keeps it fitted to its
 * container, and takes it all back down.
 *
 * Its lifetime is the terminal's, not the tab's. A session opens when the
 * terminal is first displayed and closes when the view stops representing that
 * terminal. Hiding the tab is a {@link TerminalViewSession.reveal} boundary and
 * nothing more: it must not detach, because a detach costs a fresh attachment
 * and a full replay on the way back, and output arriving meanwhile would never
 * reach the buffer at all.
 *
 * The protocol itself belongs to {@link TerminalAttachmentController}; the
 * arithmetic belongs to `terminalFitPlan.ts`; the reading position belongs to
 * the surface's pin. What is left here — and what these ports make provable —
 * is *ordering*: a replay resets the buffer before the queue may write to it, a
 * hidden surface catches up on theme and settings before it is measured, and a
 * disposed session touches nothing afterwards.
 *
 * React appears nowhere below. The view owns the container, the ResizeObserver
 * and the gesture listeners, because those are DOM; everything else is here.
 */

import {
  TerminalAttachmentController,
  type TerminalAttachmentLease,
} from "./terminalAttachmentController.ts";
import type { TerminalClientModel } from "./terminalClientModel.ts";
import { clampTerminalGeometry, type TerminalGeometry } from "./terminalFitPlan.ts";
import { TerminalFitScheduler } from "./terminalFitScheduler.ts";
import type { TerminalInput } from "./terminalSemanticInput.ts";
import type { TerminalSurface } from "./terminalSurface.ts";
import type { TerminalViewportPin } from "./terminalViewportPin.ts";
import {
  requiredHistoryWindow,
  type TerminalHistoryRequest,
} from "./terminalViewportComposition.ts";
import { TerminalReadingAnchor } from "./terminalReadingAnchor.ts";
import type {
  TerminalAnchorId,
  TerminalAttachmentId,
  TerminalDescriptor,
  TerminalEffect,
  TerminalEvent,
  TerminalInputOutcome,
  TerminalProjectedPoint,
  TerminalProjectedSpace,
  TerminalReplay,
} from "./types.ts";

/** Byte delivery into the surface's parser, keyed to this terminal. */
export interface TerminalSessionOutput {
  /** Start delivering, reporting an emptied queue and a local overflow. */
  register(afterDrain: () => void, onOverflow: () => void): void;
  /** Stop delivering; the surface's baseline is no longer valid. */
  unregister(): void;
  /** Hand exact bytes to the surface, in order. */
  release(bytes: readonly number[]): void;
}

/**
 * Pinning one of this terminal's lines.
 *
 * The same three operations the host offers, unchecked: the reading anchor
 * decodes them, for the reason the client model decodes a history window.
 */
export interface TerminalSessionAnchors {
  anchor(space: TerminalProjectedSpace, at: TerminalProjectedPoint): Promise<unknown>;
  resolveAnchor(anchor: TerminalAnchorId): Promise<unknown>;
  releaseAnchor(anchor: TerminalAnchorId): Promise<unknown>;
}

/** The host operations this session performs for its terminal. */
export interface TerminalSessionRuntime {
  attach(onEvent: (event: TerminalEvent) => void): Promise<TerminalAttachmentLease>;
  detach(attachmentId: TerminalAttachmentId): Promise<void>;
  observeDescriptor(descriptor: TerminalDescriptor): void;
  /** Submit exact bytes. Legacy; area 05 deletes it with the byte path. */
  write(data: string): Promise<TerminalInputOutcome>;
  /**
   * Submit what a person did and let the host encode it.
   *
   * Present only on the semantic path, for the same reason
   * {@link TerminalViewSessionPorts.model} is: a client with no such transport
   * is refused rather than quietly written as bytes it chose itself.
   */
  sendInput?(input: TerminalInput): Promise<TerminalInputOutcome>;
  /** Read the rows behind the viewport, unchecked. Semantic path only. */
  readHistory?(startRow: number, rows: number): Promise<unknown>;
  /**
   * Pin one line and keep asking where it went. Semantic path only.
   *
   * Absent means the reading position is a row number and nothing corrects it,
   * which is what every client had before the host's anchors crossed a
   * boundary.
   */
  anchors?: TerminalSessionAnchors;
  /** Whether the host terminal currently accepts input. */
  acceptsInput(): boolean;
  resize(attachmentId: TerminalAttachmentId, size: TerminalGeometry): Promise<void>;
}

/** Everything the reveal sequence waits on. */
export interface TerminalSessionTiming {
  /** Resolve once the container has been laid out. */
  nextFrame(): Promise<void>;
  /** Run a task after a delay and return its cancel. */
  defer(task: () => void, delayMs: number): () => void;
  /** Resolve once webfonts have loaded, or null where that is unobservable. */
  fontsReady(): Promise<void> | null;
}

export interface TerminalViewSessionPorts {
  surface: TerminalSurface;
  /**
   * Byte delivery into the surface's parser.
   *
   * Absent on the semantic path, where there is no parser on the client and
   * nothing to deliver bytes to. Area 05 deletes it.
   */
  output?: TerminalSessionOutput;
  runtime: TerminalSessionRuntime;
  timing: TerminalSessionTiming;
  /**
   * The client model this session's terminal lives in, on the semantic path.
   *
   * Supplying one selects that path for the whole session: the attachment
   * writes state instead of bytes, and local input is submitted as meaning.
   * The model outlives the session — hiding a tab or rebuilding a surface must
   * not end a terminal's continuity — so it is given here rather than made
   * here, and disposing the session does not dispose it.
   */
  model?: TerminalClientModel;
  /**
   * One occurrence that is not screen state: a bell, a clipboard write, a
   * title. Delivered once each, in the order the host reported them.
   *
   * The model holds them until somebody takes them, so this port is what takes
   * them. Absent on the byte path, where the client's own parser raises them.
   */
  reportEffect?(effect: TerminalEffect): void;
  /** Report a failure the user has to know about. */
  notifyError(title: string, error: unknown): void;
}

/**
 * Quiet period before the reveal takes focus and fits one last time. Carried
 * over unchanged from the view this session replaced.
 */
const REVEAL_SETTLE_MS = 100;

export class TerminalViewSession {
  readonly #ports: TerminalViewSessionPorts;
  readonly #controller: TerminalAttachmentController;
  readonly #fit: TerminalFitScheduler;

  /** Cancels the settle the current reveal deferred, if one is still waiting. */
  #cancelSettle: (() => void) | null = null;
  /** Stops watching the model for a reading position that needs history. */
  #unwatchModel: (() => void) | null = null;
  /** The history read in flight, so one read is not asked for twice. */
  #readingHistory: TerminalHistoryRequest | null = null;
  /** The last read asked for, and the screen it was asked against. */
  #historyRead: { request: TerminalHistoryRequest; sequence: number } | null = null;
  /** Holds the reader's line while row numbers move under it. */
  readonly #reading: TerminalReadingAnchor | null;
  #disposed = false;

  constructor(ports: TerminalViewSessionPorts) {
    this.#ports = ports;

    const model = ports.model;
    const anchors = ports.runtime.anchors;
    this.#reading = model && anchors
      ? new TerminalReadingAnchor({
          anchor: (space, at) => anchors.anchor(space, at),
          resolveAnchor: (anchor) => anchors.resolveAnchor(anchor),
          releaseAnchor: (anchor) => anchors.releaseAnchor(anchor),
          intent: () => model.viewportIntent,
          setIntent: (intent) => model.setViewportIntent(intent),
          notifyError: (title, error) => ports.notifyError(title, error),
        })
      : null;

    this.#fit = new TerminalFitScheduler({
      measure: () => {
        const proposed = ports.surface.proposeGeometry();
        if (!proposed) return null;
        return {
          current: ports.surface.geometry(),
          proposed,
          bufferRows: ports.surface.bufferRows(),
        };
      },
      applySize: (size) => this.#applySize(size),
      defer: (task, delayMs) => ports.timing.defer(task, delayMs),
    });

    // Every port below is a local surface, output-queue or host operation.
    // Ordering and recovery belong to the controller.
    this.#controller = new TerminalAttachmentController({
      attach: (onEvent) => ports.runtime.attach(onEvent),
      detach: (attachmentId) => ports.runtime.detach(attachmentId),
      observeDescriptor: (descriptor) => ports.runtime.observeDescriptor(descriptor),
      model: ports.model,
      installReplay: (replay) => this.#installReplay(replay),
      // A session with no byte queue has nothing to stop, and the controller
      // stops output on every transition whichever path it is on.
      stopOutput: () => ports.output?.unregister(),
      releaseOutput: (bytes) => this.#releaseOutput(bytes),
      acceptsInput: () => ports.runtime.acceptsInput(),
      write: (data) => ports.runtime.write(data),
      sendInput: ports.runtime.sendInput
        ? (input) => ports.runtime.sendInput!(input)
        : undefined,
      readHistory: ports.runtime.readHistory
        ? (startRow, rows) => ports.runtime.readHistory!(startRow, rows)
        : undefined,
      publishAttachmentId: (attachmentId) =>
        ports.surface.publishAttachmentId(attachmentId),
      reportError: (error) => {
        if (import.meta.env?.DEV) {
          console.error("Failed to attach terminal renderer:", error);
        }
        ports.notifyError("Couldn’t attach terminal", error);
      },
    });
  }

  /** Where the user is reading. The view feeds gestures to it. */
  get pin(): TerminalViewportPin {
    return this.#ports.surface.pin;
  }

  /** Mount the surface, open the input path, and reveal the terminal. */
  start(): void {
    this.#ports.surface.open();
    this.#ports.surface.setInputSink((data) => this.#submitInput(data));
    this.#ports.surface.setSemanticInputSink?.((input) => this.#submitSemanticInput(input));
    // A reader who scrolls back is displaying rows the host has not sent, so
    // the session watches for that and reads them. The model announces both
    // halves of it: a moved reading position, and a screen that advanced under
    // one that has already moved.
    this.#unwatchModel = this.#ports.model?.subscribe(() => {
      // The anchor first: it is what makes the reading position the read is
      // computed from a line rather than a remembered number.
      this.#reading?.observe();
      this.#readDisplayedHistory();
      this.#reportEffects();
    }) ?? null;
    this.reveal();
  }

  /**
   * The surface is on screen again.
   *
   * Everything the reveal does is a catch-up, so this is safe to call whenever
   * the terminal is shown. It does not re-attach: the attachment never left.
   */
  reveal(): void {
    if (this.#disposed) return;
    void this.#reveal();
  }

  /** The container may have changed size. */
  requestFit(): Promise<void> {
    return this.#fit.request();
  }

  /**
   * The theme changed while this terminal is displayed.
   *
   * The colours a terminal is drawn in, and nothing that decides how much of it
   * fits: the same catch-up the reveal performs, for a surface that is already
   * on screen and therefore gets no reveal.
   */
  applyTheme(): void {
    if (this.#disposed) return;
    this.#ports.surface.applyCurrentTheme();
  }

  /**
   * The font or cursor settings changed while this terminal is displayed.
   *
   * A different font is a different cell, so the terminal holds a different
   * number of columns and rows than the host was last told. The fit is what
   * tells it, and it is the session's own fit — a second measurement here would
   * be a second policy about the smallest size a terminal may have.
   */
  applySettings(): void {
    if (this.#disposed) return;
    this.#ports.surface.applyCurrentSettings();
    void this.#fit.request();
  }

  /**
   * Hand on what the host reported beside the screen.
   *
   * Taken only when somebody is listening: an occurrence nobody can be told
   * about waits in the model rather than being dropped on the way past.
   */
  #reportEffects(): void {
    const report = this.#ports.reportEffect;
    const model = this.#ports.model;
    if (!report || !model) return;
    for (const effect of model.drainEffects()) report(effect);
  }

  /** Terminal: no later callback may reach the surface or the host. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
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

  /**
   * Catch a surface up on everything that changed while it was hidden, then
   * attach.
   *
   * The order is the point. Theme and settings are applied by their global
   * appliers only to visible terminals — writing them to a `display:none`
   * terminal corrupts xterm's scroll state — so a surface that is becoming
   * visible has to collect them itself, before anything measures it.
   */
  async #reveal(): Promise<void> {
    const { surface, timing } = this.#ports;

    // A reveal supersedes the one before it: that settle was scheduled against
    // a surface which has since been hidden and shown again.
    this.#cancelSettle?.();
    this.#cancelSettle = null;

    await timing.nextFrame();
    if (this.#disposed) return;

    surface.applyCurrentTheme();
    surface.applyCurrentSettings();
    // Rendering has to be restored after a visibility change even when nothing
    // above it changed.
    surface.refresh();

    await this.#fit.request();
    if (this.#disposed) return;

    // The fit skips its viewport preservation when the dimensions did not
    // change — the common case when returning to a tab — so the scroll position
    // a hidden container zeroed is re-asserted unconditionally, and only after
    // the work above, which can itself move the buffer.
    surface.resyncViewport();

    // Only the first reveal attaches. Every later one finds the attachment the
    // hidden terminal kept, and returns at once.
    await this.#controller.start();
    if (this.#disposed) return;
    await this.#fit.request();
    if (this.#disposed) return;

    this.#cancelSettle = timing.defer(() => {
      void this.#fit.request();
      surface.focus();
    }, REVEAL_SETTLE_MS);

    // A webfont that lands after the first fit changes the cell metrics, so the
    // terminal is measured again once the font is real.
    void timing.fontsReady()?.then(() => {
      if (this.#disposed) return;
      void this.#fit.request();
      surface.logActiveFont();
    });
  }

  /**
   * The one input path.
   *
   * The controller decides admission and returns a typed outcome; this only
   * reacts to it. An unavailable keystroke raced the terminal's lifecycle and
   * is not the user's problem.
   */
  #submitInput(data: string): void {
    void this.#controller.submitInput(data).then((outcome) => this.#noteInput(outcome));
  }

  /**
   * The same path, for a surface that reports meaning instead of bytes.
   *
   * What it becomes is the host's, so nothing here inspects it, and the outcome
   * is treated exactly as a byte submission's: the reading position follows an
   * accepted keystroke whichever encoding carried it.
   */
  #submitSemanticInput(input: TerminalInput): void {
    void this.#controller.submitSemanticInput(input).then((outcome) => this.#noteInput(outcome));
  }

  /**
   * Read the history rows the reading position displays.
   *
   * Asked on every announced change, because a history row number is a position
   * that eviction moves: the rows behind a reader who is scrolled back while
   * the child writes are re-read rather than assumed to be the ones already
   * held. One read is in flight at a time; the announcement that the answer
   * makes brings the next one if it is still needed.
   */
  #readDisplayedHistory(): void {
    const model = this.#ports.model;
    const state = model?.state;
    if (this.#disposed || !model || !state || this.#readingHistory) return;
    const wanted = requiredHistoryWindow(state.screen, model.viewportIntent, model.history);
    if (!wanted) return;
    // The same read, against the same screen, was already answered: history
    // holds fewer rows than the screen's count says, and asking again would
    // produce the same short answer for as long as the reader sits still.
    const last = this.#historyRead;
    if (
      last
      && last.sequence === state.sequence
      && last.request.startRow === wanted.startRow
      && last.request.rows === wanted.rows
    ) {
      return;
    }
    this.#readingHistory = wanted;
    this.#historyRead = { request: wanted, sequence: state.sequence };
    void this.#controller
      .readHistory(wanted.startRow, wanted.rows)
      .then((outcome) => {
        this.#readingHistory = null;
        if (this.#disposed) return;
        if (outcome.status === "committed") {
          // The reading position can move while a read is in flight — an
          // anchor the host resolved onto another row does exactly that — and
          // the announcement that carried it was refused by the guard above.
          // The window is re-checked here rather than waiting for a frame.
          this.#readDisplayedHistory();
          return;
        }
        // A refused window is the host and the client disagreeing about what
        // history holds, which is not something to paint around silently.
        this.#ports.notifyError(
          "Couldn’t read terminal history",
          new Error(outcome.detail ?? outcome.reason),
        );
      })
      .catch((error: unknown) => {
        this.#readingHistory = null;
        if (this.#disposed) return;
        this.#ports.notifyError("Couldn’t read terminal history", error);
      });
  }

  #noteInput(outcome: TerminalInputOutcome): void {
    if (this.#disposed || outcome.status === "unavailable") return;
    if (outcome.status === "accepted") {
      this.#ports.surface.pin.noteInputAccepted();
      return;
    }
    if (import.meta.env?.DEV) {
      console.error("Failed to write terminal input:", outcome.error);
    }
    this.#ports.notifyError("Couldn’t write to terminal", outcome.error);
  }

  /**
   * Hand bytes to the surface, or report a stream this session cannot read.
   *
   * A session on the semantic path has no byte queue. Bytes arriving for it are
   * not a frame to drop quietly: either the host answered an encoding nobody
   * asked for, or this session was wired with neither a queue nor a model.
   */
  #releaseOutput(bytes: readonly number[]): void {
    const { output } = this.#ports;
    if (output) {
      output.release(bytes);
      return;
    }
    this.#ports.notifyError(
      "Couldn’t show terminal output",
      new Error("This terminal session has no byte path to write child output into"),
    );
  }

  #installReplay(replay: TerminalReplay): void {
    const { output, surface } = this.#ports;
    if (!output) {
      this.#ports.notifyError(
        "Couldn’t show terminal output",
        new Error("This terminal session was given a replay it has no parser for"),
      );
      return;
    }

    output.unregister();
    // The reset below discards the buffer the user was reading; remember the
    // position before it is gone.
    surface.pin.noteReplayReset();
    surface.reset();
    surface.resize(
      clampTerminalGeometry({ columns: replay.columns, rows: replay.rows }),
    );

    output.register(
      () => {
        // The queue reports a drain only once it has emptied, so the replayed
        // buffer is whole by the time this runs.
        surface.pin.noteOutputDrained();
        this.#controller.noteOutputDrained();
      },
      () => this.#controller.requestRecovery(),
    );
  }

  async #applySize(geometry: TerminalGeometry): Promise<void> {
    const { surface, runtime } = this.#ports;

    const size = clampTerminalGeometry(geometry);
    const current = surface.geometry();
    if (current.columns === size.columns && current.rows === size.rows) return;

    surface.resizePreservingViewport(size);

    // Without an attachment there is no PTY to tell: the size the host learns
    // is the one carried by the next attach.
    const attachmentId = this.#controller.attachmentId;
    if (!attachmentId) return;
    await runtime.resize(attachmentId, size).catch((error: unknown) => {
      if (import.meta.env?.DEV) {
        console.error("Failed to resize PTY:", error);
      }
    });
  }

}

export function startTerminalViewSession(
  ports: TerminalViewSessionPorts,
): TerminalViewSession {
  const session = new TerminalViewSession(ports);
  session.start();
  return session;
}
