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
import { clampTerminalGeometry, type TerminalGeometry } from "./terminalFitPlan.ts";
import { TerminalFitScheduler } from "./terminalFitScheduler.ts";
import type { TerminalSurface } from "./terminalSurface.ts";
import type { TerminalViewportPin } from "./terminalViewportPin.ts";
import type {
  TerminalAttachmentId,
  TerminalDescriptor,
  TerminalEvent,
  TerminalInputOutcome,
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

/** The host operations this session performs for its terminal. */
export interface TerminalSessionRuntime {
  attach(onEvent: (event: TerminalEvent) => void): Promise<TerminalAttachmentLease>;
  detach(attachmentId: TerminalAttachmentId): Promise<void>;
  observeDescriptor(descriptor: TerminalDescriptor): void;
  write(data: string): Promise<TerminalInputOutcome>;
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
  output: TerminalSessionOutput;
  runtime: TerminalSessionRuntime;
  timing: TerminalSessionTiming;
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
  #disposed = false;

  constructor(ports: TerminalViewSessionPorts) {
    this.#ports = ports;

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
      installReplay: (replay) => this.#installReplay(replay),
      stopOutput: () => ports.output.unregister(),
      releaseOutput: (bytes) => ports.output.release(bytes),
      acceptsInput: () => ports.runtime.acceptsInput(),
      write: (data) => ports.runtime.write(data),
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

  /** Terminal: no later callback may reach the surface or the host. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#ports.surface.setInputSink(null);
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
    void this.#controller.submitInput(data).then((outcome) => {
      if (this.#disposed || outcome.status === "unavailable") return;
      if (outcome.status === "accepted") {
        this.#ports.surface.pin.noteInputAccepted();
        return;
      }
      if (import.meta.env?.DEV) {
        console.error("Failed to write terminal input:", outcome.error);
      }
      this.#ports.notifyError("Couldn’t write to terminal", outcome.error);
    });
  }

  #installReplay(replay: TerminalReplay): void {
    const { output, surface } = this.#ports;

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
