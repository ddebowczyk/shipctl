/**
 * The semantic implementation of {@link TerminalSurface}, and the peer of
 * `terminalXtermSurface.ts`.
 *
 * What a terminal *is* lives in the client model; what a frame *looks like*
 * lives in `terminalCellPaint.ts`; when and how much is drawn lives in
 * `terminalCellPresenter.ts`; the drawing lives in `terminalCanvasTarget.ts`.
 * This binds those four to the interface a view session already speaks, so the
 * session does not learn that its terminal stopped being an interpreter.
 *
 * Four answers here differ from the xterm peer, and each is the same fact
 * stated once: this surface holds no terminal state.
 *
 * - **`geometry()` is the model's**, because the size of the screen is the
 *   host's answer and arrives in a frame. A local resize would be a second copy
 *   of it.
 * - **`resize` and `resizePreservingViewport` do nothing.** The session sends
 *   the size to the host, and the host's next frame is the resize. Reflow is
 *   the host's too, which is why `bufferRows()` is zero: the deferral it feeds
 *   exists to keep a client from reflowing a long scrollback, and this client
 *   never reflows anything.
 * - **`reset()` does nothing.** It exists to discard a buffer before an ANSI
 *   replay is written over it, and no replay reaches this path.
 * - **`setInputSink` is accepted and never called.** Bytes chosen by a client
 *   are the second copy of the child's modes this path exists to end; local
 *   input leaves through {@link TerminalSemanticSurface.setSemanticInputSink}
 *   as what the person did.
 *
 * The factory below takes ports and touches no DOM, so every one of those
 * answers is provable in the lane. The binding under it is the browser half:
 * a canvas, its context, the stores, and the listeners.
 */

import { buildCSSFontFamily, TERMINAL_LINE_HEIGHT } from "@shipctl/core/appearance";
import { useThemeStore } from "@shipctl/core/appearance";
import { createCanvasPaintTarget } from "./terminalCanvasTarget.ts";
import type { TerminalCellMetrics, TerminalPaintPlan } from "./terminalCellPaint.ts";
import { TerminalCellPresenter } from "./terminalCellPresenter.ts";
import type { TerminalSurfacePalette } from "./terminalCellSurface.ts";
import type { TerminalClientModel } from "./terminalClientModel.ts";
import {
  cellsForBox,
  measureTerminalCell,
  type TerminalFontRequest,
} from "./terminalFontMetrics.ts";
import type { TerminalGeometry } from "./terminalFitPlan.ts";
import { resolveKeybindingPreset } from "./keybindingPresets.ts";
import { createTerminalPointerRouter } from "./terminalPointerRouter.ts";
import {
  semanticFocusInput,
  semanticKeyInput,
  semanticPasteInput,
  semanticTextInput,
  type TerminalInput,
  type TerminalSurfaceGeometry,
} from "./terminalSemanticInput.ts";
import type { TerminalSurface } from "./terminalSurface.ts";
import { createTerminalSurfacePalette } from "./terminalTheme.ts";
import { TerminalViewportPin } from "./terminalViewportPin.ts";
import {
  composeDisplayedScreen,
  displayedCellInScreenSpace,
  scrollViewportIntent,
  viewportIntentAtRow,
} from "./terminalViewportComposition.ts";
import { useKeybindingStore } from "./useKeybindingStore.ts";
import { useTerminalSettingsStore } from "./useTerminalSettingsStore.ts";
import type {
  TerminalAttachmentId,
  TerminalSelectionRequest,
  TerminalSelectionState,
} from "./types.ts";

/** A surface whose local input names what a person did. */
export interface TerminalSemanticSurface extends TerminalSurface {
  /** Install the sink for observed input, or null to close it. */
  setSemanticInputSink(sink: ((input: TerminalInput) => void) | null): void;
  /**
   * Hand one observed action to the sink, for whatever is watching the pixels.
   *
   * An action observed between sessions is dropped, exactly as a keystroke into
   * a terminal with no open input path is.
   */
  reportInput(input: TerminalInput): void;
  /** How this client drew the terminal, or null while it has drawn nothing. */
  surfaceGeometry(): TerminalSurfaceGeometry | null;
}

export interface TerminalSemanticSurfacePorts {
  readonly model: TerminalClientModel;
  readonly presenter: TerminalCellPresenter;
  /** Where the user is reading. Built over the model by the caller. */
  readonly pin: TerminalViewportPin;
  /** Put the presentation on screen. Idempotent. */
  mount(): void;
  focus(): void;
  /** The container in CSS pixels, or null while it cannot be measured. */
  measureContainer(): { readonly width: number; readonly height: number } | null;
  /** The pixel size of one cell now, or null while the font cannot be measured. */
  measureCell(): TerminalCellMetrics | null;
  /** Re-read the theme the presenter paints with. */
  applyTheme(): void;
  /** Re-read the font and cursor settings the presentation uses. */
  applySettings(): void;
  publishAttachmentId(attachmentId: TerminalAttachmentId | null): void;
  /** Dev-only diagnostics naming the font actually in use. */
  logActiveFont(): void;
}

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

    setInputSink() {
      // Accepted and dropped. See the note at the top of this file: this
      // surface produces no bytes, so there is nothing to send through a byte
      // sink, and refusing it would only make the session carry the knowledge.
    },

    setSemanticInputSink(sink) {
      semanticSink = sink;
    },

    reportInput(input) {
      semanticSink?.(input);
    },

    applyCurrentTheme() {
      ports.applyTheme();
      // The palette is read on every frame, so what is owed is a frame drawn
      // with pixels that are no longer the previous theme's.
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
      // Nothing to discard: no replay is written into this surface.
    },

    resize() {
      // The host owns the screen's size. The session tells it; the frame that
      // follows is the resize.
    },

    resizePreservingViewport() {
      // The same, and the reading position is the model's, not the buffer's.
    },

    geometry(): TerminalGeometry {
      const state = ports.model.state;
      // Before the first frame there is no screen and no honest answer. Zero is
      // not a size a terminal has, so the fit treats it as a change and asks
      // the host — which is the only thing that could settle it.
      if (!state) return { columns: 0, rows: 0 };
      return { columns: state.screen.columns, rows: state.screen.rows };
    },

    proposeGeometry(): TerminalGeometry | null {
      const box = ports.measureContainer();
      if (!box || box.width <= 0 || box.height <= 0) return null;
      const cell = ports.measureCell();
      if (!cell) return null;
      const cells = cellsForBox(box, cell);
      // The floor a terminal is held to is the session's, applied to every
      // size it sends. A second one here would be a second policy.
      return cells === null ? null : { columns: cells.cols, rows: cells.rows };
    },

    bufferRows() {
      // See the note at the top: the host reflows, so nothing here is deferred
      // on the length of a buffer this surface does not hold.
      return 0;
    },

    resyncViewport() {
      // The reading position is model state and survived being hidden. What did
      // not survive is the pixels, and those are owed a frame.
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
        // The canvas is the screen. Padding is a fact about how this client
        // drew it, and this client draws no padding.
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

/**
 * The reading position, over the model.
 *
 * Every answer is the model's viewport intent read in the pin's own terms: a
 * line is a host history row, and the distance from the bottom is how many rows
 * of history are below the top of the display. Nothing is read back from a
 * buffer, because there is no buffer — which is why hiding and showing a
 * terminal cannot move the reader here.
 */
function createModelViewportPin(model: TerminalClientModel): TerminalViewportPin {
  const screen = () => model.state?.screen ?? null;

  return new TerminalViewportPin({
    bottomOffset: () => {
      const state = screen();
      const intent = model.viewportIntent;
      if (!state || intent.followBottom || intent.historyAnchor === null) return 0;
      return Math.max(0, state.scrollbackRows - intent.historyAnchor);
    },
    baseY: () => screen()?.scrollbackRows ?? 0,
    scrollToBottom: () => {
      model.setViewportIntent({ followBottom: true, historyAnchor: null });
    },
    scrollToLine: (line) => {
      const state = screen();
      if (!state) return;
      model.setViewportIntent(viewportIntentAtRow(state, line));
    },
  });
}

// ── The browser half ────────────────────────────────────────────────

/** One terminal's semantic presentation, bound to the container it is in. */
export interface SemanticTerminalBinding {
  readonly surface: TerminalSemanticSurface;
  readonly model: TerminalClientModel;
  readonly presenter: TerminalCellPresenter;
  /** The live attachment id, for the terminal's other readers. */
  attachmentId(): TerminalAttachmentId | null;
  /**
   * Display this presentation in another container.
   *
   * A tab shown again is a new container around the same terminal, and the
   * pixels move to it rather than being built a second time — the same reuse
   * the xterm peer gets from opening one engine into a new element. The move
   * happens on the next mount, which is what a session start does.
   */
  attachTo(container: HTMLElement): void;
  /** Tear down the presentation. The model is untouched. */
  dispose(): void;
}

/**
 * The weights a run is drawn in.
 *
 * The CSS keywords, not numbers: `normal` and `bold` are what the style system
 * names these, and a number would be this file choosing one of the weights a
 * variable font offers.
 */
const RUN_WEIGHTS = { weightNormal: "normal", weightBold: "bold" } as const;

function currentFont(): TerminalFontRequest {
  const { fontFamily, fontSize } = useTerminalSettingsStore.getState().settings;
  return {
    family: buildCSSFontFamily(fontFamily),
    sizePx: fontSize,
    lineHeight: TERMINAL_LINE_HEIGHT,
  };
}

function currentPalette(): TerminalSurfacePalette {
  return createTerminalSurfacePalette(useThemeStore.getState().theme);
}

/** What a pointer needs from outside this presentation. */
export interface SemanticTerminalBindingPorts {
  /**
   * Ask the host to select, and answer with what it now holds.
   *
   * The next frame carries the cells; the answer carries the text, which is the
   * only place the text exists — unwrapping a wrapped line is the host's. Null
   * for a request that could not be sent.
   */
  select(request: TerminalSelectionRequest): Promise<TerminalSelectionState | null>;
  /** Open what an OSC 8 hyperlink names. */
  openLink(uri: string): void;
}

/**
 * Bind one model to one container.
 *
 * The canvas is created here and nowhere else, and it is the only DOM this
 * capability's presentation owns. Its CSS size follows the plan the presenter
 * drew, because the plan's pixels are the host's columns multiplied by a
 * measured cell: letting CSS decide the size instead would scale the frame and
 * put the client back in charge of how wide a cell is.
 */
export function bindSemanticTerminal(
  model: TerminalClientModel,
  container: HTMLElement,
  ports: SemanticTerminalBindingPorts,
): SemanticTerminalBinding {
  /** The container the presentation belongs to now. See `attachTo`. */
  let host = container;
  const canvas = document.createElement("canvas");
  canvas.style.display = "block";
  // The canvas is the picture and takes no keyboard. A canvas cannot: `paste`,
  // `copy` and the composition events are the editing host's, and an input
  // method needs a caret to place its candidates against. The text area below
  // is where all of those arrive, and a click on the picture hands it there.
  canvas.style.outline = "none";

  /**
   * The terminal's keyboard: a text area the person never sees.
   *
   * It is kept empty except while it holds the selection for a copy, because
   * what it holds is never the terminal's state — the host's screen is. Every
   * key, composition and paste that lands here leaves as meaning.
   */
  const keyboard = document.createElement("textarea");
  keyboard.setAttribute("aria-label", "Terminal");
  keyboard.autocapitalize = "off";
  keyboard.autocomplete = "off";
  keyboard.spellcheck = false;
  // Reachable by keyboard, because the terminal is today: xterm gives its own
  // helper text area `tabIndex = 0`, and a migration that quietly removed the
  // Tab stop would take the terminal away from anybody not using a pointer.
  keyboard.tabIndex = 0;
  keyboard.style.position = "absolute";
  keyboard.style.opacity = "0";
  keyboard.style.width = "1px";
  keyboard.style.height = "1px";
  keyboard.style.padding = "0";
  keyboard.style.border = "none";
  keyboard.style.resize = "none";
  keyboard.style.overflow = "hidden";

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("This webview cannot draw a terminal: no 2D canvas context");
  }
  const metricsContext = document.createElement("canvas").getContext("2d");

  let font = currentFont();
  let palette = currentPalette();
  const buildTarget = () =>
    createCanvasPaintTarget(context, {
      font: { family: font.family, sizePx: font.sizePx, ...RUN_WEIGHTS },
      devicePixelRatio: window.devicePixelRatio || 1,
    });
  let target = buildTarget();

  const measureCell = (): TerminalCellMetrics | null =>
    metricsContext ? measureTerminalCell(metricsContext, font) : null;

  const presenter = new TerminalCellPresenter({
    model,
    target: {
      beginFrame: (size) => target.beginFrame(size),
      clear: (rect) => target.clear(rect),
      fill: (rect, color) => target.fill(rect, color),
      drawRun: (run) => target.drawRun(run),
      underline: (rect, color) => target.underline(rect, color),
      cursor: (rect, shape, color) => target.cursor(rect, shape, color),
      endFrame: () => target.endFrame(),
      requiresFullFrame: (size) => target.requiresFullFrame(size),
    },
    metrics: measureCell,
    palette: () => palette,
    schedule: (paint) => {
      const handle = requestAnimationFrame(() => paint());
      return () => cancelAnimationFrame(handle);
    },
    defer: (task, delayMs) => {
      const handle = window.setTimeout(task, delayMs);
      return () => window.clearTimeout(handle);
    },
    onFrame: (plan: TerminalPaintPlan) => {
      // The backing store is device pixels and the target sized it; these are
      // the CSS pixels the same frame occupies.
      canvas.style.width = `${plan.width}px`;
      canvas.style.height = `${plan.height}px`;
    },
  });

  let attachmentId: TerminalAttachmentId | null = null;

  const surface = createSemanticTerminalSurface({
    model,
    presenter,
    pin: createModelViewportPin(model),
    mount() {
      if (canvas.parentElement === host) return;
      host.appendChild(canvas);
      host.appendChild(keyboard);
    },
    focus() {
      keyboard.focus();
    },
    measureContainer() {
      const width = host.clientWidth;
      const height = host.clientHeight;
      // A hidden or unlaid-out container measures zero, which is not a size to
      // send to a child process.
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    },
    measureCell,
    applyTheme() {
      palette = currentPalette();
    },
    applySettings() {
      font = currentFont();
      // The target holds the font it draws with, so it is rebuilt rather than
      // mutated: a target that kept the old family would keep drawing in it.
      target = buildTarget();
    },
    publishAttachmentId(id) {
      attachmentId = id;
    },
    logActiveFont() {
      if (!import.meta.env?.DEV) return;
      console.log(`Terminal font: ${font.family} at ${font.sizePx}px`, measureCell());
    },
  });

  const onKey = (event: KeyboardEvent) => {
    // A composition owns the keys it is made of. Reporting them is right — the
    // host is told they are composing and encodes nothing — but refusing the
    // browser's default would take the keys away from the input method.
    if (event.isComposing) {
      const composing = semanticKeyInput(event);
      if (composing) surface.reportInput(composing);
      return;
    }

    // A preset is what the person asked for, stated as meaning. It is resolved
    // before the key itself so the combination it claims does not also arrive
    // as the key it is made of.
    const preset = resolveKeybindingPreset(useKeybindingStore.getState().settings, event);
    if (preset) {
      event.preventDefault();
      if (event.type === "keydown") surface.reportInput(preset.input);
      return;
    }

    const input = semanticKeyInput(event);
    if (!input) return;
    // The host decides what the key becomes, so the browser's own default for
    // it — scrolling, a shortcut, a beep — is not wanted.
    event.preventDefault();
    surface.reportInput(input);
  };

  /** Start a composition from an empty field, whatever the copy left behind. */
  const onCompositionStart = () => {
    keyboard.value = "";
  };

  const onTextInput = (event: Event) => {
    const text = (event as CompositionEvent).data;
    // Emptied whether or not there is text: what an input method leaves behind
    // is its own, and the terminal's state is the host's screen.
    keyboard.value = "";
    if (typeof text !== "string" || text.length === 0) return;
    surface.reportInput(semanticTextInput(text));
  };

  const onPaste = (event: ClipboardEvent) => {
    // The child receives the paste as a paste — bracketed or not is its mode —
    // so the text area must not also receive it as typing.
    event.preventDefault();
    const text = event.clipboardData?.getData("text");
    if (!text) return;
    surface.reportInput(semanticPasteInput(text));
  };

  /**
   * Put the host's selected text where a copy will find it.
   *
   * The platform decides what a copy gesture is — a shortcut, a menu, a
   * right-click — and it copies what is selected in the focused field. So the
   * host's answer is held there, selected, and nothing here reads a shortcut or
   * writes to a clipboard. A selection the host reports as empty leaves the
   * field empty, which is what makes the terminal's own copy do nothing rather
   * than copy the selection before it.
   */
  const holdForCopy = (state: TerminalSelectionState | null): void => {
    const text = state?.active ? (state.text ?? "") : "";
    if (keyboard.value === text) return;
    keyboard.value = text;
    if (text) keyboard.select();
  };

  const router = createTerminalPointerRouter({
    screen: () => model.state?.screen ?? null,
    displayed: () => {
      const screen = model.state?.screen;
      if (!screen) return null;
      return composeDisplayedScreen(screen, model.history, model.viewportIntent);
    },
    project: (cell) => {
      const screen = model.state?.screen;
      // A cell can only have come from a hit test against a displayed screen,
      // which cannot exist before the first frame.
      if (!screen) return { column: cell.column, row: cell.row };
      return displayedCellInScreenSpace(screen, model.viewportIntent, cell);
    },
    metrics: measureCell,
    geometry: () => surface.surfaceGeometry(),
    reportInput: (input) => surface.reportInput(input),
    select: (request) => {
      void ports.select(request).then(holdForCopy);
    },
    openLink: (uri) => ports.openLink(uri),
    scroll: (rows) => {
      const screen = model.state?.screen;
      if (!screen) return;
      model.setViewportIntent(scrollViewportIntent(screen, model.viewportIntent, rows));
    },
    schedule: (step) => {
      // The same clock the presenter paints on, because the rows a held drag
      // pulls in are rows the reader sees arrive one frame at a time.
      const handle = requestAnimationFrame(() => step());
      return () => cancelAnimationFrame(handle);
    },
  });

  /** Where an event happened, in the canvas's own pixels. */
  const pointOf = (event: { clientX: number; clientY: number }) => {
    const box = canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const onPointer = (event: PointerEvent) => {
    // The picture takes no focus, so a click on it hands the keyboard to the
    // field that does. Without this the terminal would go deaf on every click.
    if (event.type === "pointerdown") keyboard.focus();
    router.handle(event, pointOf(event));
  };

  const onWheel = (event: WheelEvent) => {
    // The page does not scroll: this canvas is the terminal, and what a wheel
    // over it moves is either the child's own view or this client's reading
    // position. The wheel carries a position because a child that asked for the
    // mouse is told where the pointer was.
    event.preventDefault();
    router.wheel(event, pointOf(event));
  };

  // A cancelled pointer never releases, so the press it left behind is dropped
  // rather than closed by whatever release arrives next.
  const onPointerCancel = () => router.reset();

  const onFocus = () => surface.reportInput(semanticFocusInput(true));
  const onBlur = () => surface.reportInput(semanticFocusInput(false));

  keyboard.addEventListener("keydown", onKey);
  keyboard.addEventListener("keyup", onKey);
  keyboard.addEventListener("compositionstart", onCompositionStart);
  keyboard.addEventListener("compositionend", onTextInput);
  keyboard.addEventListener("paste", onPaste);
  canvas.addEventListener("pointerdown", onPointer);
  canvas.addEventListener("pointerup", onPointer);
  canvas.addEventListener("pointermove", onPointer);
  canvas.addEventListener("pointercancel", onPointerCancel);
  // Not passive: a wheel over the terminal is the terminal's, and refusing the
  // page's own scroll is the whole point of handling it.
  canvas.addEventListener("wheel", onWheel, { passive: false });
  // Focus is the keyboard's, because the keyboard is where it lands.
  keyboard.addEventListener("focus", onFocus);
  keyboard.addEventListener("blur", onBlur);

  return {
    surface,
    model,
    presenter,
    attachmentId: () => attachmentId,
    attachTo(next) {
      host = next;
    },
    dispose() {
      keyboard.removeEventListener("keydown", onKey);
      keyboard.removeEventListener("keyup", onKey);
      keyboard.removeEventListener("compositionstart", onCompositionStart);
      keyboard.removeEventListener("compositionend", onTextInput);
      keyboard.removeEventListener("paste", onPaste);
      keyboard.removeEventListener("focus", onFocus);
      keyboard.removeEventListener("blur", onBlur);
      keyboard.remove();
      canvas.removeEventListener("pointerdown", onPointer);
      canvas.removeEventListener("pointerup", onPointer);
      canvas.removeEventListener("pointermove", onPointer);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("wheel", onWheel);
      presenter.dispose();
      surface.setSemanticInputSink(null);
      canvas.remove();
    },
  };
}
