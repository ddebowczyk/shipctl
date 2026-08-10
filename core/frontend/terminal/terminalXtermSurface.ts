/**
 * The xterm implementation of {@link TerminalSurface}.
 *
 * This is the only module that constructs terminals, so it is also where the
 * engine's shape shows: addons, parser handlers, option writes, buffer reads.
 * Everything above it — the view session, the fit scheduler, the viewport pin —
 * names the surface interface instead, which is what keeps them provable
 * without a DOM.
 *
 * It value-imports the xterm bundles and its stylesheet and therefore stays out
 * of the capability's logic entry point.
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

import { TERMINAL_LINE_HEIGHT, buildCSSFontFamily } from "@shipctl/core/appearance";
import { useThemeStore } from "@shipctl/core/appearance";
import { openUrl } from "@shipctl/core/platform";
import { terminalCache, type TerminalCacheEntry } from "./terminalCache.ts";
import type { TerminalGeometry } from "./terminalFitPlan.ts";
import { resolveKeybindingPreset } from "./keybindingPresets.ts";
import { notifyAgent } from "./notifications.ts";
import {
  createTerminalRendererState,
  reconcileTerminalRenderer,
  setTerminalRendererFactories,
} from "./terminalRenderer.ts";
import { browserTerminalRendererFactories } from "./terminalRendererAddons.ts";
import { TRANSITIONAL_RENDERER_SCROLLBACK_ROWS } from "./terminalRetention.ts";
import type { TerminalSurface } from "./terminalSurface.ts";
import { createTerminalTheme } from "./terminalTheme.ts";
import { parseOscNotificationMessage } from "./terminalOscNotification.ts";
import {
  registerTerminal,
  unregisterTerminal,
  writeTerminalOutput,
} from "./terminalOutputQueue.ts";
import type { TerminalSessionOutput } from "./terminalViewSession.ts";
import {
  preserveTerminalViewport,
  resyncTerminalViewport,
  terminalBottomOffset,
} from "./terminalViewport.ts";
import { TerminalViewportPin } from "./terminalViewportPin.ts";
import { useKeybindingStore } from "./useKeybindingStore.ts";
import { useTerminalSettingsStore } from "./useTerminalSettingsStore.ts";
import type { TerminalAttachmentId, TerminalId } from "./types.ts";

// Registering the addon factories here keeps the xterm addon bundles out of the
// capability's logic entry point while still guaranteeing they are installed
// before any terminal exists for the renderer seam to reconcile.
setTerminalRendererFactories(browserTerminalRendererFactories);

function createEntry(terminalId: TerminalId): TerminalCacheEntry {
  const termSettings = useTerminalSettingsStore.getState().settings;
  const term = new Terminal({
    cursorBlink: termSettings.cursorBlink,
    cursorStyle: termSettings.cursorStyle,
    fontSize: termSettings.fontSize,
    fontFamily: buildCSSFontFamily(termSettings.fontFamily),
    lineHeight: TERMINAL_LINE_HEIGHT,
    theme: createTerminalTheme(useThemeStore.getState().theme),
    scrollback: TRANSITIONAL_RENDERER_SCROLLBACK_ROWS,
    allowTransparency: true,
    allowProposedApi: true,
    linkHandler: {
      activate: (_ev, url) => {
        void openUrl(url);
      },
    },
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  const unicodeAddon = new Unicode11Addon();
  term.loadAddon(unicodeAddon);
  term.unicode.activeVersion = "11";
  term.loadAddon(new WebLinksAddon((_ev, url) => {
    void openUrl(url);
  }));

  const entry: TerminalCacheEntry = {
    term,
    fitAddon,
    attachmentId: null,
    inputSink: null,
    viewportPin: new TerminalViewportPin({
      bottomOffset: () => terminalBottomOffset(term),
      baseY: () => term.buffer.active.baseY,
      scrollToBottom: () => term.scrollToBottom(),
      scrollToLine: (line) => term.scrollToLine(line),
    }),
    ...createTerminalRendererState(),
  };

  // Every locally produced keystroke leaves through the live session's sink,
  // which decides admission. Between sessions there is nowhere to send it.
  const submitInput = (data: string) => entry.inputSink?.(data);
  term.onData(submitInput);

  term.onBell(() => {
    void notifyAgent(terminalId, "Terminal bell");
  });

  // OSC 9 notifications from coding agents (Claude Code, Codex, Gemini).
  term.parser.registerOscHandler(9, (data) => {
    const message = parseOscNotificationMessage(data);
    if (message) void notifyAgent(terminalId, message);
    return true;
  });

  term.attachCustomKeyEventHandler((ev) => {
    const preset = resolveKeybindingPreset(useKeybindingStore.getState().settings, ev);
    if (!preset) return true; // let xterm handle normally
    if (ev.type === "keydown") submitInput(preset.sequence);
    return false; // prevent xterm default handling
  });

  terminalCache.set(terminalId, entry);
  return entry;
}

/** Name the font a terminal is actually rendering with, in dev builds only. */
function reportActiveFont(term: Terminal): void {
  if (!import.meta.env?.DEV) return;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return;

  const cssFont = term.options.fontFamily ?? "";
  const fonts = cssFont.split(",").map((f) => f.trim().replace(/^["']|["']$/g, ""));
  ctx.font = `${term.options.fontSize}px serif`;
  const serifWidth = ctx.measureText("mmmm").width;
  for (const font of fonts) {
    ctx.font = `${term.options.fontSize}px "${font}", serif`;
    if (ctx.measureText("mmmm").width !== serifWidth) {
      console.log(`Terminal font: "${font}" (active)`);
      break;
    }
  }
}

/** An xterm terminal, bound to the container it is displayed in. */
export interface XtermTerminalBinding {
  surface: TerminalSurface;
  output: TerminalSessionOutput;
}

/**
 * Bind one terminal to one container.
 *
 * The terminal itself is cached and survives across containers; the pin and the
 * input sink live with it, so a view that hides and returns finds the reading
 * position it left.
 */
export function bindXtermTerminal(
  terminalId: TerminalId,
  container: HTMLElement,
): XtermTerminalBinding {
  const entry = terminalCache.get(terminalId) ?? createEntry(terminalId);
  const { term } = entry;

  const surface: TerminalSurface = {
    pin: entry.viewportPin,

    open() {
      // `element` is set by open() and is the engine's own record of being
      // mounted, so a second session cannot open the terminal twice.
      if (term.element) return;
      term.open(container);
      // The renderer is chosen after open() so the addons can reach the DOM.
      reconcileTerminalRenderer(term, entry, useThemeStore.getState().theme);
    },

    setInputSink(sink) {
      entry.inputSink = sink;
    },

    applyCurrentTheme() {
      const theme = useThemeStore.getState().theme;
      term.options.theme = createTerminalTheme(theme);
      // The renderer was deferred along with the theme, so it is reconciled
      // against the theme that is actually being installed.
      reconcileTerminalRenderer(term, entry, theme);
    },

    applyCurrentSettings() {
      const settings = useTerminalSettingsStore.getState().settings;
      const cssFont = buildCSSFontFamily(settings.fontFamily);
      const fontMetricsChanged =
        term.options.fontFamily !== cssFont || term.options.fontSize !== settings.fontSize;

      term.options.cursorStyle = settings.cursorStyle;
      term.options.cursorBlink = settings.cursorBlink;
      term.options.fontFamily = cssFont;
      term.options.fontSize = settings.fontSize;

      // Clear the renderer's glyph texture atlas so the new font is measured
      // from scratch; without it xterm keeps the old font's metrics and clips.
      if (fontMetricsChanged) entry.rendererAddon?.clearTextureAtlas?.();
    },

    refresh() {
      term.refresh(0, term.rows - 1);
    },

    focus() {
      term.focus();
    },

    reset() {
      term.reset();
    },

    resize(size: TerminalGeometry) {
      term.resize(size.columns, size.rows);
    },

    resizePreservingViewport(size: TerminalGeometry) {
      preserveTerminalViewport(term, () => {
        term.resize(size.columns, size.rows);
      });
    },

    geometry() {
      return { columns: term.cols, rows: term.rows };
    },

    proposeGeometry() {
      const proposed = entry.fitAddon.proposeDimensions();
      // A hidden container has no computed width or height, and the addon
      // divides by them rather than refusing, so its proposal degrades to NaN.
      // The session keeps observing while a tab is hidden; unmeasurable has to
      // mean "no proposal" or that NaN would be sent to the PTY.
      if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) {
        return null;
      }
      return { columns: proposed.cols, rows: proposed.rows };
    },

    bufferRows() {
      return term.buffer.active.length;
    },

    resyncViewport() {
      resyncTerminalViewport(term, terminalBottomOffset(term));
    },

    publishAttachmentId(attachmentId: TerminalAttachmentId | null) {
      entry.attachmentId = attachmentId;
    },

    logActiveFont() {
      reportActiveFont(term);
    },
  };

  const output: TerminalSessionOutput = {
    register(afterDrain, onOverflow) {
      registerTerminal(terminalId, term, afterDrain, onOverflow);
    },
    unregister() {
      unregisterTerminal(terminalId);
    },
    release(bytes) {
      writeTerminalOutput(terminalId, bytes);
    },
  };

  return { surface, output };
}

/** Destroy a terminal and everything held for it. */
export function disposeXtermTerminal(terminalId: TerminalId): void {
  const entry = terminalCache.get(terminalId);
  if (!entry) return;
  entry.viewportPin.dispose();
  entry.inputSink = null;
  entry.term.dispose();
  terminalCache.delete(terminalId);
  unregisterTerminal(terminalId);
}
