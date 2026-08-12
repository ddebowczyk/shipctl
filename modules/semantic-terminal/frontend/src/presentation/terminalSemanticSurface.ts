/** The semantic surface contract and its state-free implementation. */

import type { TerminalCellMetrics } from "./terminalCellPaint.ts";
import { TerminalCellPresenter } from "./terminalCellPresenter.ts";
import type { TerminalClientModel } from "./terminalClientModel.ts";
import {
  cellsForBox,
} from "./terminalFontMetrics.ts";
import type { TerminalGeometry } from "./terminalFitPlan.ts";
import type { TerminalInput, TerminalSurfaceGeometry } from "./terminalSemanticInput.ts";
import type { TerminalSurface } from "./terminalSurface.ts";
import { TerminalViewportPin } from "./terminalViewportPin.ts";

/** A surface whose local input names what a person did. */
export interface TerminalSemanticSurface extends TerminalSurface {
  setSemanticInputSink(sink: ((input: TerminalInput) => void) | null): void;
  reportInput(input: TerminalInput): void;
  surfaceGeometry(): TerminalSurfaceGeometry | null;
}

export interface TerminalSemanticSurfacePorts {
  readonly model: TerminalClientModel;
  readonly presenter: TerminalCellPresenter;
  readonly pin: TerminalViewportPin;
  mount(): void;
  focus(): void;
  measureContainer(): { readonly width: number; readonly height: number } | null;
  measureCell(): TerminalCellMetrics | null;
  applyTheme(): void;
  applySettings(): void;
  publishAttachmentId(attachmentId: string | null): void;
  logActiveFont(): void;
}

/**
 * Build the semantic presentation surface without a DOM or PTY dependency.
 * Geometry and reflow remain facts of the selected native semantic driver.
 */
export function createSemanticTerminalSurface(
  ports: TerminalSemanticSurfacePorts,
): TerminalSemanticSurface {
  let semanticSink: ((input: TerminalInput) => void) | null = null;

  return {
    pin: ports.pin,
    open() {
      ports.mount();
      ports.presenter.start();
    },
    setVisible(visible) {
      ports.presenter.setVisible(visible);
    },
    setInputSink() {
      // This surface never produces client-chosen terminal bytes.
    },
    setSemanticInputSink(sink) {
      semanticSink = sink;
    },
    reportInput(input) {
      semanticSink?.(input);
    },
    applyCurrentTheme() {
      ports.applyTheme();
      ports.presenter.invalidate();
    },
    applyCurrentSettings() {
      ports.applySettings();
      ports.presenter.invalidate();
    },
    refresh() {
      ports.presenter.invalidate();
    },
    focus() {
      ports.focus();
    },
    reset() {
      // No ANSI replay is installed on the semantic browser surface.
    },
    resize() {
      // The host applies the physical size; the next semantic frame is truth.
    },
    resizePreservingViewport() {
      // The model, not a browser buffer, owns the reading position.
    },
    geometry(): TerminalGeometry {
      const state = ports.model.state;
      return state
        ? { columns: state.screen.columns, rows: state.screen.rows }
        : { columns: 0, rows: 0 };
    },
    proposeGeometry(): TerminalGeometry | null {
      const box = ports.measureContainer();
      if (!box || box.width <= 0 || box.height <= 0) return null;
      const cell = ports.measureCell();
      if (!cell) return null;
      const cells = cellsForBox(box, cell);
      return cells === null ? null : { columns: cells.cols, rows: cells.rows };
    },
    bufferRows() {
      return 0;
    },
    resyncViewport() {
      ports.presenter.invalidate();
    },
    publishAttachmentId(attachmentId) {
      ports.publishAttachmentId(attachmentId);
    },
    surfaceGeometry(): TerminalSurfaceGeometry | null {
      const state = ports.model.state;
      const cell = ports.measureCell();
      if (!state || !cell) return null;
      return {
        screenWidth: state.screen.columns * cell.cellWidth,
        screenHeight: state.screen.rows * cell.cellHeight,
        cellWidth: cell.cellWidth,
        cellHeight: cell.cellHeight,
        paddingTop: 0,
        paddingBottom: 0,
        paddingLeft: 0,
        paddingRight: 0,
      };
    },
    logActiveFont() {
      ports.logActiveFont();
    },
  };
}
