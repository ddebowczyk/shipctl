/**
 * When a fit decision is applied.
 *
 * `terminalFitPlan.ts` says what a container observation should do; this owns
 * the one thing that decision cannot carry — time. A column change against a
 * long buffer is expensive to reflow, so it waits for the gesture to settle
 * while the cheap row change lands at once, and a later observation must be
 * able to supersede or preserve that pending width.
 *
 * The timer is a port, so every ordering — supersede, preserve, cancel on
 * disposal — is provable without a live container.
 */

import {
  COLUMN_REFLOW_SETTLE_MS,
  planTerminalFit,
  type TerminalGeometry,
} from "./terminalFitPlan.ts";

export interface TerminalFitMeasurement {
  current: TerminalGeometry;
  proposed: TerminalGeometry;
  /** Lines held in the active buffer, including scrollback. */
  bufferRows: number;
}

export interface TerminalFitPorts {
  /** Measure the surface, or null while it cannot be measured. */
  measure(): TerminalFitMeasurement | null;
  /** Apply a geometry to the surface and the host. */
  applySize(size: TerminalGeometry): Promise<void>;
  /**
   * Run a task after a quiet period and return its cancel. Defaults to
   * `setTimeout`; tests inject a timer they fire explicitly.
   */
  defer?(task: () => void, delayMs: number): () => void;
}

function deferWithTimeout(task: () => void, delayMs: number): () => void {
  const handle = setTimeout(task, delayMs);
  return () => clearTimeout(handle);
}

export class TerminalFitScheduler {
  readonly #ports: TerminalFitPorts;
  readonly #defer: (task: () => void, delayMs: number) => () => void;

  #cancelDeferred: (() => void) | null = null;
  #disposed = false;

  constructor(ports: TerminalFitPorts) {
    this.#ports = ports;
    this.#defer = ports.defer ?? deferWithTimeout;
  }

  /** Observe the container and apply whatever the fit plan asks for. */
  async request(): Promise<void> {
    if (this.#disposed) return;

    const measurement = this.#ports.measure();
    if (!measurement) return;

    const plan = planTerminalFit(measurement);
    // An unchanged plan leaves a pending column change alone: it was scheduled
    // against a width this observation has not reached yet.
    if (plan.kind === "unchanged") return;

    if (plan.kind === "resize") {
      this.#clearDeferred();
      await this.#ports.applySize(plan.size);
      return;
    }

    if (plan.immediate) await this.#ports.applySize(plan.immediate);
    this.#clearDeferred();
    const deferred = plan.deferred;
    this.#cancelDeferred = this.#defer(() => {
      this.#cancelDeferred = null;
      void this.#ports.applySize(deferred);
    }, COLUMN_REFLOW_SETTLE_MS);
  }

  /** Terminal: a pending column change is dropped rather than applied late. */
  dispose(): void {
    this.#disposed = true;
    this.#clearDeferred();
  }

  #clearDeferred(): void {
    const cancel = this.#cancelDeferred;
    this.#cancelDeferred = null;
    cancel?.();
  }
}
