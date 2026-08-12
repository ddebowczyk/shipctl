import type { ModuleTerminalPresentationPort } from "@shipctl/module-api";

import { createTerminalImeLifecycle, placeTerminalIme, type TerminalImePlacement } from "../browserInteraction.ts";
import { createCanvasPaintTarget } from "./terminalCanvasTarget.ts";
import type { TerminalCellMetrics, TerminalPaintPlan } from "./terminalCellPaint.ts";
import { TerminalCellPresenter } from "./terminalCellPresenter.ts";
import type { TerminalSurfacePalette } from "./terminalCellSurface.ts";
import type { TerminalClientModel } from "./terminalClientModel.ts";
import { measureTerminalCell, type TerminalFontRequest } from "./terminalFontMetrics.ts";
import { resolveKeybindingPreset } from "./keybindingPresets.ts";
import {
  copyToTerminalClipboard,
  pasteFromTerminalClipboard,
  terminalClipboardShortcut,
  type TerminalClipboardAction,
  type TerminalClipboardPorts,
} from "./terminalClipboard.ts";
import { createTerminalPointerRouter } from "./terminalPointerRouter.ts";
import {
  semanticFocusInput,
  semanticKeyInput,
  semanticPasteInput,
  semanticTextInput,
} from "./terminalSemanticInput.ts";
import {
  createSemanticTerminalSurface,
  type TerminalSemanticSurface,
} from "./terminalSemanticSurface.ts";
import { TerminalViewportPin } from "./terminalViewportPin.ts";
import {
  composeDisplayedScreen,
  displayedCellInScreenSpace,
  scrollViewportIntent,
  viewportIntentAtRow,
} from "./terminalViewportComposition.ts";
import type { TerminalSelectionRequest, TerminalSelectionState } from "../semanticTypes.ts";

export interface SemanticTerminalBinding {
  readonly surface: TerminalSemanticSurface;
  readonly model: TerminalClientModel;
  readonly presenter: TerminalCellPresenter;
  attachmentId(): string | null;
  failPrimaryRenderer(): Promise<boolean>;
  rendererHealthy(): boolean;
  attachTo(container: HTMLElement): void;
  dispose(): void;
}

export interface SemanticTerminalBindingPorts {
  select(request: TerminalSelectionRequest): Promise<TerminalSelectionState | null>;
  openLink(uri: string): void;
  reviewPaste(text: string, submit: () => void): void;
  clipboardUnavailable(action: TerminalClipboardAction, error: unknown): void;
  rendererUnavailable(error: unknown, retry: () => void): void;
  recordPaint?(milliseconds: number): void;
  recordDiagnostic?(
    event: string,
    facts?: Readonly<Record<string, string | number | boolean | null>>,
  ): void;
}

const RUN_WEIGHTS = { weightNormal: "normal", weightBold: "bold" } as const;

/**
 * Keep the hidden keyboard target focused when a person presses the canvas.
 *
 * A canvas pointer press has a browser default focus action. If it is not
 * cancelled, that action runs after the listener focuses the textarea and
 * immediately blurs it again. The terminal then looks live but receives no
 * keyboard events.
 */
export function focusSemanticTerminalFromPointer(
  event: Pick<PointerEvent, "type" | "button" | "preventDefault">,
  focus: () => void,
): void {
  if (event.type !== "pointerdown" || event.button !== 0) return;
  event.preventDefault();
  focus();
}

function viewportPin(model: TerminalClientModel): TerminalViewportPin {
  const screen = () => model.state?.screen ?? null;
  return new TerminalViewportPin({
    bottomOffset: () => {
      const state = screen();
      const intent = model.viewportIntent;
      if (!state || intent.followBottom || intent.historyAnchor === null) return 0;
      return Math.max(0, state.scrollbackRows - intent.historyAnchor);
    },
    baseY: () => screen()?.scrollbackRows ?? 0,
    scrollToBottom: () => model.setViewportIntent({ followBottom: true, historyAnchor: null }),
    scrollToLine: (line) => {
      const state = screen();
      if (state) model.setViewportIntent(viewportIntentAtRow(state, line));
    },
  });
}

/** Bind the semantic model to one module-owned Canvas2D presentation. */
export function bindSemanticTerminal(
  model: TerminalClientModel,
  container: HTMLElement,
  presentation: ModuleTerminalPresentationPort,
  ports: SemanticTerminalBindingPorts,
): SemanticTerminalBinding {
  let host = container;
  const canvas = document.createElement("canvas");
  canvas.style.display = "block";
  canvas.style.outline = "none";
  const keyboard = document.createElement("textarea");
  keyboard.setAttribute("aria-label", "Terminal");
  keyboard.autocapitalize = "off";
  keyboard.autocomplete = "off";
  keyboard.spellcheck = false;
  keyboard.tabIndex = 0;
  Object.assign(keyboard.style, {
    position: "absolute", zIndex: "1", opacity: "0", width: "1px", height: "1px",
    padding: "0", border: "none", resize: "none", overflow: "hidden", margin: "0", outline: "none",
  });

  const context = canvas.getContext("2d");
  if (!context) throw new Error("This webview cannot draw a terminal: no 2D canvas context");
  const metricsContext = document.createElement("canvas").getContext("2d");
  const current = () => presentation.getSnapshot();
  let font: TerminalFontRequest = current().font;
  let palette: TerminalSurfacePalette = current().palette;
  let imePlacement: TerminalImePlacement | null = null;
  let imeActive = false;
  const syncIme = () => {
    if (imePlacement) {
      keyboard.style.left = `${imePlacement.left}px`;
      keyboard.style.top = `${imePlacement.top}px`;
    }
    if (!imeActive || !imePlacement) {
      keyboard.style.opacity = "0";
      keyboard.style.width = "1px";
      keyboard.style.height = "1px";
      return;
    }
    Object.assign(keyboard.style, {
      opacity: "1", width: `${imePlacement.width}px`, height: `${imePlacement.height}px`,
      lineHeight: `${imePlacement.height}px`, font: `${font.sizePx}px ${font.family}`,
      color: palette.foreground, caretColor: palette.cursor, background: palette.background,
    });
  };
  const targetFor = () => createCanvasPaintTarget(context, {
    font: { family: font.family, sizePx: font.sizePx, ...RUN_WEIGHTS },
    devicePixelRatio: window.devicePixelRatio || 1,
  });
  let target = targetFor();
  let rendererGeneration = 0;
  let paintedRendererGeneration = -1;
  let failNextFrame = false;
  let failureNoticeOpen = false;
  let injectedFailureResolve: ((recovered: boolean) => void) | null = null;
  const measureCell = (): TerminalCellMetrics | null =>
    metricsContext ? measureTerminalCell(metricsContext, font) : null;
  let presenter: TerminalCellPresenter;
  const rebuild = () => {
    canvas.width = canvas.width;
    target = targetFor();
    rendererGeneration += 1;
    presenter.invalidate();
  };
  const recover = (error: unknown) => {
    try {
      rebuild();
      injectedFailureResolve?.(true);
    } catch (recoveryError) {
      injectedFailureResolve?.(false);
      if (!failureNoticeOpen) {
        failureNoticeOpen = true;
        ports.rendererUnavailable(recoveryError ?? error, () => {
          failureNoticeOpen = false;
          try { rebuild(); } catch (retryError) { recover(retryError); }
        });
      }
    } finally {
      injectedFailureResolve = null;
    }
  };
  presenter = new TerminalCellPresenter({
    model,
    target: {
      beginFrame: (size) => {
        if (failNextFrame) {
          failNextFrame = false;
          throw new Error("Injected Canvas2D painter failure");
        }
        target.beginFrame(size);
      },
      clear: (rect) => target.clear(rect), fill: (rect, color) => target.fill(rect, color),
      drawRun: (run) => target.drawRun(run), underline: (rect, color) => target.underline(rect, color),
      cursor: (rect, shape, color) => target.cursor(rect, shape, color), endFrame: () => target.endFrame(),
      requiresFullFrame: (size) => target.requiresFullFrame(size),
    },
    metrics: measureCell,
    palette: () => palette,
    cursorBlink: () => current().cursorBlink,
    schedule: (paint) => {
      const handle = requestAnimationFrame(() => paint());
      return () => cancelAnimationFrame(handle);
    },
    defer: (task, delayMs) => {
      const handle = window.setTimeout(task, delayMs);
      return () => window.clearTimeout(handle);
    },
    onFrame: (plan: TerminalPaintPlan) => {
      canvas.style.width = `${plan.width}px`;
      canvas.style.height = `${plan.height}px`;
      imePlacement = placeTerminalIme(plan);
      syncIme();
      paintedRendererGeneration = rendererGeneration;
    },
    observePaint: ports.recordPaint,
    onFailure: recover,
  });

  let attachmentId: string | null = null;
  const surface = createSemanticTerminalSurface({
    model, presenter, pin: viewportPin(model),
    mount: () => {
      if (canvas.parentElement !== host) {
        host.append(canvas, keyboard);
      }
    },
    focus: () => keyboard.focus(),
    measureContainer: () => {
      const { clientWidth: width, clientHeight: height } = host;
      return width > 0 && height > 0 ? { width, height } : null;
    },
    measureCell,
    applyTheme: () => { palette = current().palette; syncIme(); },
    applySettings: () => {
      font = current().font;
      target = targetFor();
      rendererGeneration += 1;
      syncIme();
    },
    publishAttachmentId: (id) => { attachmentId = id; },
    logActiveFont: () => {
      if (import.meta.env.DEV) console.log(`Terminal font: ${font.family} at ${font.sizePx}px`, measureCell());
    },
  });
  const ime = createTerminalImeLifecycle({
    present: (state) => { imeActive = state.active; if (!state.active) keyboard.value = ""; syncIme(); },
    commit: (text) => surface.reportInput(semanticTextInput(text)),
  });
  const onKey = (event: KeyboardEvent) => {
    if (terminalClipboardShortcut(event)) return;
    if (ime.ownsKey(event.isComposing)) {
      const input = semanticKeyInput(event);
      if (input) surface.reportInput(input);
      return;
    }
    const preset = resolveKeybindingPreset(current().keybindings, event);
    if (preset) {
      event.preventDefault();
      if (event.type === "keydown") surface.reportInput(preset.input);
      return;
    }
    const input = semanticKeyInput(event);
    if (!input) return;
    event.preventDefault();
    surface.reportInput(input);
  };
  const onCompositionStart = () => { keyboard.value = ""; ime.start(); };
  const onCompositionUpdate = (event: CompositionEvent) => ime.update(event.data ?? "");
  const onCompositionEnd = (event: CompositionEvent) => { keyboard.value = ""; ime.finish(event.data ?? ""); };
  const onPaste = (event: ClipboardEvent) => {
    event.preventDefault();
    const text = event.clipboardData?.getData("text");
    if (text) ports.reviewPaste(text, () => surface.reportInput(semanticPasteInput(text)));
  };
  const holdForCopy = (state: TerminalSelectionState | null) => {
    const text = state?.active ? (state.text ?? "") : "";
    if (keyboard.value === text) return;
    keyboard.value = text;
    if (text) keyboard.select();
  };
  const clipboardPorts: TerminalClipboardPorts = {
    readText: () => {
      if (!navigator.clipboard?.readText) {
        return Promise.reject(new Error("Clipboard read is unavailable in this webview"));
      }
      return navigator.clipboard.readText();
    },
    writeText: (text) => {
      if (!navigator.clipboard?.writeText) {
        return Promise.reject(new Error("Clipboard write is unavailable in this webview"));
      }
      return navigator.clipboard.writeText(text);
    },
    reviewPaste: ports.reviewPaste,
    submitPaste: (text) => surface.reportInput(semanticPasteInput(text)),
    unavailable: ports.clipboardUnavailable,
  };
  let contextMenu: HTMLDivElement | null = null;
  const closeContextMenu = () => {
    contextMenu?.remove();
    contextMenu = null;
  };
  const menuButton = (
    label: "Copy" | "Paste",
    disabled: boolean,
    action: () => void,
  ): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "semantic-terminal-context-menu__item";
    button.role = "menuitem";
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener("click", () => {
      closeContextMenu();
      action();
      keyboard.focus({ preventScroll: true });
    });
    return button;
  };
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    router.reset();
    closeContextMenu();
    const menu = document.createElement("div");
    menu.className = "semantic-terminal-context-menu";
    menu.role = "menu";
    menu.setAttribute("aria-label", "Terminal context menu");
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    menu.append(
      menuButton("Copy", keyboard.value.length === 0, () => {
        void copyToTerminalClipboard(keyboard.value, clipboardPorts);
      }),
      menuButton("Paste", false, () => {
        void pasteFromTerminalClipboard(clipboardPorts);
      }),
    );
    document.body.append(menu);
    contextMenu = menu;
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(event.clientX, window.innerWidth - box.width))}px`;
    menu.style.top = `${Math.max(0, Math.min(event.clientY, window.innerHeight - box.height))}px`;
  };
  const onDocumentPointerDown = (event: PointerEvent) => {
    if (contextMenu && !contextMenu.contains(event.target as Node)) closeContextMenu();
  };
  const onDocumentKeyDown = (event: KeyboardEvent) => {
    if (!contextMenu || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeContextMenu();
    keyboard.focus({ preventScroll: true });
  };
  const router = createTerminalPointerRouter({
    screen: () => model.state?.screen ?? null,
    displayed: () => {
      const screen = model.state?.screen;
      return screen ? composeDisplayedScreen(screen, model.history, model.viewportIntent) : null;
    },
    project: (cell) => {
      const screen = model.state?.screen;
      return screen ? displayedCellInScreenSpace(screen, model.viewportIntent, cell) : cell;
    },
    metrics: measureCell,
    geometry: () => surface.surfaceGeometry(),
    reportInput: (input) => surface.reportInput(input),
    select: (request) => { void ports.select(request).then(holdForCopy); },
    openLink: ports.openLink,
    scroll: (rows) => {
      const screen = model.state?.screen;
      if (screen) model.setViewportIntent(scrollViewportIntent(screen, model.viewportIntent, rows));
    },
    schedule: (step) => {
      const handle = requestAnimationFrame(() => step());
      return () => cancelAnimationFrame(handle);
    },
  });
  const pointOf = (event: { clientX: number; clientY: number }) => {
    const box = canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const onPointer = (event: PointerEvent) => {
    if (event.button === 2 || (event.type === "pointermove" && (event.buttons & 2) !== 0)) return;
    focusSemanticTerminalFromPointer(event, () => keyboard.focus({ preventScroll: true }));
    router.handle(event, pointOf(event));
  };
  const onWheel = (event: WheelEvent) => { event.preventDefault(); router.wheel(event, pointOf(event)); };
  const onFocus = () => {
    ports.recordDiagnostic?.("keyboard_focus_gained");
    surface.reportInput(semanticFocusInput(true));
  };
  const onBlur = (event: FocusEvent) => {
    const related = event.relatedTarget;
    ports.recordDiagnostic?.("keyboard_focus_lost", {
      nextTarget: related instanceof HTMLElement ? related.tagName.toLowerCase() : "none",
    });
    surface.reportInput(semanticFocusInput(false));
  };
  keyboard.addEventListener("keydown", onKey);
  keyboard.addEventListener("keyup", onKey);
  keyboard.addEventListener("compositionstart", onCompositionStart);
  keyboard.addEventListener("compositionupdate", onCompositionUpdate);
  keyboard.addEventListener("compositionend", onCompositionEnd);
  keyboard.addEventListener("paste", onPaste);
  keyboard.addEventListener("focus", onFocus);
  keyboard.addEventListener("blur", onBlur);
  canvas.addEventListener("pointerdown", onPointer);
  canvas.addEventListener("pointerup", onPointer);
  canvas.addEventListener("pointermove", onPointer);
  canvas.addEventListener("pointercancel", () => router.reset());
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContextMenu);
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("keydown", onDocumentKeyDown, true);
  return {
    surface, model, presenter,
    attachmentId: () => attachmentId,
    failPrimaryRenderer: () => {
      if (!model.state || injectedFailureResolve) return Promise.resolve(false);
      return new Promise((resolve) => { injectedFailureResolve = resolve; failNextFrame = true; presenter.invalidate(); });
    },
    rendererHealthy: () => injectedFailureResolve === null && paintedRendererGeneration === rendererGeneration,
    attachTo: (next) => { host = next; },
    dispose: () => {
      injectedFailureResolve?.(false);
      closeContextMenu();
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      document.removeEventListener("keydown", onDocumentKeyDown, true);
      keyboard.remove();
      canvas.remove();
      presenter.dispose();
      surface.setSemanticInputSink(null);
    },
  };
}
