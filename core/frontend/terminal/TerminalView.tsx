import { terminalCache, type TerminalCacheEntry } from "./terminalCache.ts";
import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import {
  createTerminalRendererState,
  reconcileTerminalRenderer,
  setTerminalRendererFactories,
} from "./terminalRenderer.ts";
import { browserTerminalRendererFactories } from "./terminalRendererAddons.ts";
import { writePty, resizePty, openUrl } from "@shep/core/platform";
import {
  flushPendingOutput,
  registerTerminal,
  unregisterTerminal,
} from "./usePty.ts";
import { TERMINAL_LINE_HEIGHT, buildCSSFontFamily } from "@shep/core/appearance";
import {
  preserveTerminalViewport,
  resyncTerminalViewport,
  terminalBottomOffset,
} from "./terminalViewport.ts";
import { createTerminalTheme } from "./terminalTheme.ts";
import { useThemeStore } from "@shep/core/appearance";
import { notifyAgent } from "./notifications.ts";
import { KEYBINDING_PRESETS } from "./keybindingPresets.ts";
import { useKeybindingStore } from "./useKeybindingStore.ts";
import { useTerminalSettingsStore } from "./useTerminalSettingsStore.ts";

interface TerminalViewProps {
  ptyId: number;
  visible: boolean;
}

// This is the only module that constructs terminals, so registering the addon
// factories here keeps the xterm addon bundles out of the capability's logic
// entry point while still guaranteeing they are installed before any terminal
// exists for the renderer seam to reconcile.
setTerminalRendererFactories(browserTerminalRendererFactories);


export default function TerminalView({
  ptyId,
  visible,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const attachedRef = useRef(false);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);

  const getOrCreateTerminal = useCallback(() => {
    const cached = terminalCache.get(ptyId);
    if (cached) return cached;

    const termSettings = useTerminalSettingsStore.getState().settings;
    const term = new Terminal({
      cursorBlink: termSettings.cursorBlink,
      cursorStyle: termSettings.cursorStyle,
      fontSize: termSettings.fontSize,
      fontFamily: buildCSSFontFamily(termSettings.fontFamily),
      lineHeight: TERMINAL_LINE_HEIGHT,
      theme: createTerminalTheme(useThemeStore.getState().theme),
      scrollback: termSettings.scrollback,
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

    // Send input to PTY
    term.onData((data) => {
      writePty(ptyId, data).catch((error) => {
        if (import.meta.env.DEV) {
          console.error("Failed to write PTY input:", error);
        }
      });
    });

    // Track terminal bell (attention request)
    term.onBell(() => {
      void notifyAgent(ptyId, "Terminal bell");
    });

    // Intercept OSC 9 notifications from coding agents (Claude Code, Codex, Gemini)
    term.parser.registerOscHandler(9, (data) => {
      const message = data.startsWith("2;") ? data.slice(2) : data;
      if (message) {
        void notifyAgent(ptyId, message);
      }
      return true;
    });

    // Intercept key combos for custom keybindings
    term.attachCustomKeyEventHandler((ev) => {
      const settings = useKeybindingStore.getState().settings;
      for (const preset of KEYBINDING_PRESETS) {
        if (settings[preset.id] && preset.match(ev)) {
          if (ev.type === "keydown") {
            writePty(ptyId, preset.sequence).catch((error) => {
              if (import.meta.env.DEV) {
                console.error("Failed to write PTY keybinding:", error);
              }
            });
          }
          return false; // prevent xterm default handling
        }
      }
      return true; // let xterm handle normally
    });

    const entry: TerminalCacheEntry = {
      term,
      fitAddon,
      ...createTerminalRendererState(),
    };
    terminalCache.set(ptyId, entry);
    return entry;
  }, [ptyId]);

  const fitAndResize = useCallback(async () => {
    const cached = terminalCache.get(ptyId);
    if (!cached) return;

    const proposedSize = cached.fitAddon.proposeDimensions();
    if (!proposedSize) return;

    const size = { cols: proposedSize.cols, rows: proposedSize.rows };
    const lastSize = lastSizeRef.current;

    if (
      lastSize &&
      lastSize.cols === size.cols &&
      lastSize.rows === size.rows &&
      cached.term.cols === size.cols &&
      cached.term.rows === size.rows
    ) {
      return;
    }

    preserveTerminalViewport(cached.term, () => {
      cached.fitAddon.fit();
    });

    lastSizeRef.current = size;
    await resizePty(ptyId, size.cols, size.rows).catch((error) => {
      if (import.meta.env.DEV) {
        console.error("Failed to resize PTY:", error);
      }
    });
  }, [ptyId]);

  useEffect(() => {
    if (!containerRef.current || !visible) return;

    const { term } = getOrCreateTerminal();
    let disposed = false;

    if (!mountedRef.current) {
      term.open(containerRef.current);
      mountedRef.current = true;

      // Choose the renderer after open() so the addons can reach the DOM.
      const cached = terminalCache.get(ptyId);
      if (cached) {
        reconcileTerminalRenderer(term, cached, useThemeStore.getState().theme);
      }
    }

    const attachTerminal = async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (disposed) return;

      // Snapshot the scroll position from xterm's internal buffer before
      // touching anything: while the container was display:none the browser
      // zeroed the DOM viewport's scrollTop, so the internal position is the
      // only surviving record of where the user was.
      const bottomOffset = terminalBottomOffset(term);

      // Re-apply the current theme now that the container is visible.
      // Theme changes that occurred while hidden were deferred to avoid
      // corrupting xterm's scroll state; the renderer was deferred with them,
      // so reconcile it against the theme that is actually being installed.
      const currentTheme = useThemeStore.getState().theme;
      const rendererEntry = terminalCache.get(ptyId);
      term.options.theme = createTerminalTheme(currentTheme);
      if (rendererEntry) {
        reconcileTerminalRenderer(term, rendererEntry, currentTheme);
      }

      // Re-apply terminal settings (font, cursor, scrollback) that may have
      // changed while this terminal was hidden. `applyTerminalSettings` skips
      // hidden terminals to avoid corrupting xterm state, so we catch up here
      // once the container is visible again. If the font changed, the
      // renderer's texture atlas is cleared so glyphs are re-measured.
      const currentTermSettings = useTerminalSettingsStore.getState().settings;
      const nextCssFont = buildCSSFontFamily(currentTermSettings.fontFamily);
      const fontMetricsChanged =
        term.options.fontFamily !== nextCssFont ||
        term.options.fontSize !== currentTermSettings.fontSize;

      term.options.cursorStyle = currentTermSettings.cursorStyle;
      term.options.cursorBlink = currentTermSettings.cursorBlink;
      term.options.scrollback = currentTermSettings.scrollback;
      term.options.fontFamily = nextCssFont;
      term.options.fontSize = currentTermSettings.fontSize;

      const cachedEntry = terminalCache.get(ptyId);
      if (fontMetricsChanged) {
        cachedEntry?.rendererAddon?.clearTextureAtlas?.();
      }

      // Refresh the viewport so rendering is restored after visibility
      // changes (e.g. closing settings overlay).
      term.refresh(0, term.rows - 1);

      await fitAndResize();
      if (disposed) return;

      // fitAndResize skips the fit (and its viewport preservation) when the
      // dimensions didn't change — the common case when returning to a tab —
      // so the zeroed DOM scrollTop must be re-asserted unconditionally.
      resyncTerminalViewport(term, bottomOffset);

      if (!attachedRef.current) {
        registerTerminal(ptyId, term);
        flushPendingOutput(ptyId);
        attachedRef.current = true;
      }

      window.setTimeout(() => {
        if (disposed) return;
        void fitAndResize();
        resyncTerminalViewport(term, bottomOffset);
        term.focus();
      }, 100);

      if ("fonts" in document) {
        void document.fonts.ready.then(() => {
          if (disposed) return;
          void fitAndResize();
          if (import.meta.env.DEV) {
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            if (ctx) {
              const cssFont = term.options.fontFamily ?? "";
              const fonts = cssFont.split(",").map(f => f.trim().replace(/^["']|["']$/g, ""));
              ctx.font = `${term.options.fontSize}px serif`;
              const serifW = ctx.measureText("mmmm").width;
              for (const font of fonts) {
                ctx.font = `${term.options.fontSize}px "${font}", serif`;
                const w = ctx.measureText("mmmm").width;
                if (w !== serifW) {
                  console.log(`Terminal font: "${font}" (active)`);
                  break;
                }
              }
            }
          }
        });
      }
    };

    void attachTerminal();

    // ResizeObserver for auto-fitting
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (disposed) return;
        void fitAndResize();
      });
    });
    observer.observe(containerRef.current);

    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [ptyId, visible, getOrCreateTerminal, fitAndResize]);


  useEffect(() => {
    return () => {
      const cached = terminalCache.get(ptyId);
      if (cached) {
        cached.term.dispose();
        terminalCache.delete(ptyId);
        unregisterTerminal(ptyId);
      }
      mountedRef.current = false;
      attachedRef.current = false;
      lastSizeRef.current = null;
    };
  }, [ptyId]);

  return (
    <div
      className="terminal-view"
      style={{
        display: visible ? "block" : "none",
      }}
    >
      <div className="terminal-underlay" />
      <div ref={containerRef} className="terminal-surface" />
    </div>
  );
}
