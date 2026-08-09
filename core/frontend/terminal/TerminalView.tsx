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
import {
  openUrl,
  type TerminalAttachmentHandle,
} from "@shipctl/core/platform";
import {
  registerTerminal,
  unregisterTerminal,
  writeTerminalOutput,
} from "./terminalOutputQueue.ts";
import { TERMINAL_LINE_HEIGHT, buildCSSFontFamily } from "@shipctl/core/appearance";
import {
  preserveTerminalViewport,
  resyncTerminalViewport,
  terminalBottomOffset,
} from "./terminalViewport.ts";
import {
  keyScrollPinIntent,
  wheelScrollPinIntent,
  type ScrollPinIntent,
} from "./terminalScrollPin.ts";
import { createTerminalTheme } from "./terminalTheme.ts";
import { useThemeStore } from "@shipctl/core/appearance";
import { notifyAgent } from "./notifications.ts";
import { KEYBINDING_PRESETS } from "./keybindingPresets.ts";
import { useKeybindingStore } from "./useKeybindingStore.ts";
import { useTerminalSettingsStore } from "./useTerminalSettingsStore.ts";
import type { TerminalEvent, TerminalId, TerminalReplay } from "./types.ts";
import { TERMINAL_CLIENT_RUNTIME } from "./terminalClientRuntime.ts";
import { useNoticeStore } from "@shipctl/core/shared";
import { getErrorMessage } from "@shipctl/core/platform";

interface TerminalViewProps {
  terminalId: TerminalId;
  visible: boolean;
}

// This is the only module that constructs terminals, so registering the addon
// factories here keeps the xterm addon bundles out of the capability's logic
// entry point while still guaranteeing they are installed before any terminal
// exists for the renderer seam to reconcile.
setTerminalRendererFactories(browserTerminalRendererFactories);


export default function TerminalView({
  terminalId,
  visible,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const attachedRef = useRef(false);
  const attachmentRef = useRef<TerminalAttachmentHandle | null>(null);
  const attachmentGenerationRef = useRef(0);
  const reattachingRef = useRef(false);
  const needsReattachRef = useRef(false);
  const inputEnabledRef = useRef(false);
  const sequenceRef = useRef(0);
  // Whether the viewport is following output. Tracked here rather than read
  // from xterm at write time: the queue writes in chunks across frames, so by
  // the time a chunk lands the buffer has already moved.
  const pinnedToBottomRef = useRef(true);
  const columnResizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getOrCreateTerminal = useCallback(() => {
    const cached = terminalCache.get(terminalId);
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
      if (!attachmentRef.current || !inputEnabledRef.current) return;
      // Typing resumes follow mode; the response to this input is the thing
      // the user is waiting to see.
      pinnedToBottomRef.current = true;
      term.scrollToBottom();
      TERMINAL_CLIENT_RUNTIME.write(terminalId, data).catch((error) => {
        if (import.meta.env.DEV) {
          console.error("Failed to write terminal input:", error);
        }
        useNoticeStore.getState().pushNotice({
          tone: "error",
          title: "Couldn’t write to terminal",
          message: getErrorMessage(error),
        });
      });
    });

    // Track terminal bell (attention request)
    term.onBell(() => {
      void notifyAgent(terminalId, "Terminal bell");
    });

    // Intercept OSC 9 notifications from coding agents (Claude Code, Codex, Gemini)
    term.parser.registerOscHandler(9, (data) => {
      const message = data.startsWith("2;") ? data.slice(2) : data;
      if (message) {
        void notifyAgent(terminalId, message);
      }
      return true;
    });

    // Intercept key combos for custom keybindings
    term.attachCustomKeyEventHandler((ev) => {
      const settings = useKeybindingStore.getState().settings;
      for (const preset of KEYBINDING_PRESETS) {
        if (settings[preset.id] && preset.match(ev)) {
          if (ev.type === "keydown") {
            if (!attachmentRef.current || !inputEnabledRef.current) return false;
            TERMINAL_CLIENT_RUNTIME.write(terminalId, preset.sequence).catch((error) => {
              if (import.meta.env.DEV) {
                console.error("Failed to write terminal keybinding:", error);
              }
              useNoticeStore.getState().pushNotice({
                tone: "error",
                title: "Couldn’t write to terminal",
                message: getErrorMessage(error),
              });
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
      attachmentId: null,
      ...createTerminalRendererState(),
    };
    terminalCache.set(terminalId, entry);
    return entry;
  }, [terminalId]);

  const applyTerminalSize = useCallback(async (cols: number, rows: number) => {
    const cached = terminalCache.get(terminalId);
    if (!cached) return;

    const size = { cols: Math.max(2, cols), rows: Math.max(2, rows) };
    if (cached.term.cols === size.cols && cached.term.rows === size.rows) return;

    preserveTerminalViewport(cached.term, () => {
      cached.term.resize(size.cols, size.rows);
    });

    const attachment = attachmentRef.current;
    if (!attachment) return;
    await TERMINAL_CLIENT_RUNTIME.resize(
      terminalId,
      attachment.attachmentId,
      size.cols,
      size.rows,
    ).catch((error) => {
      if (import.meta.env.DEV) {
        console.error("Failed to resize PTY:", error);
      }
    });
  }, [terminalId]);

  const fitAndResize = useCallback(async () => {
    const cached = terminalCache.get(terminalId);
    if (!cached) return;

    const proposedSize = cached.fitAddon.proposeDimensions();
    if (!proposedSize) return;

    const nextSize = { cols: proposedSize.cols, rows: proposedSize.rows };
    const columnsChanged = cached.term.cols !== nextSize.cols;
    const rowsChanged = cached.term.rows !== nextSize.rows;
    if (!columnsChanged && !rowsChanged) return;

    // Thresholds adopted from upstream 59e8fc7 rather than chosen here.
    const shouldDebounceColumns =
      columnsChanged && cached.term.buffer.active.length > 200;

    if (!shouldDebounceColumns) {
      if (columnResizeTimerRef.current) {
        clearTimeout(columnResizeTimerRef.current);
        columnResizeTimerRef.current = null;
      }
      await applyTerminalSize(nextSize.cols, nextSize.rows);
      return;
    }

    // Reflowing a long scrollback buffer on every width observation is costly.
    // Apply row changes immediately at the current width and settle columns
    // after the resize gesture has been quiet for 100 ms.
    if (rowsChanged) {
      await applyTerminalSize(cached.term.cols, nextSize.rows);
    }
    if (columnResizeTimerRef.current) clearTimeout(columnResizeTimerRef.current);
    columnResizeTimerRef.current = setTimeout(() => {
      columnResizeTimerRef.current = null;
      void applyTerminalSize(nextSize.cols, nextSize.rows);
    }, 100);
  }, [applyTerminalSize, terminalId]);

  useEffect(() => {
    if (!containerRef.current || !visible) return;

    const { term } = getOrCreateTerminal();
    let disposed = false;

    if (!mountedRef.current) {
      term.open(containerRef.current);
      mountedRef.current = true;

      // Choose the renderer after open() so the addons can reach the DOM.
      const cached = terminalCache.get(terminalId);
      if (cached) {
        reconcileTerminalRenderer(term, cached, useThemeStore.getState().theme);
      }
    }

    const surface = containerRef.current;
    const applyScrollPinIntent = (intent: ScrollPinIntent) => {
      if (intent === "unpin") {
        pinnedToBottomRef.current = false;
        return;
      }
      if (intent === "follow") {
        // Resumed before xterm emits onData for this key.
        pinnedToBottomRef.current = true;
        term.scrollToBottom();
        return;
      }
      // "resync": the gesture has not been applied to the buffer yet, so read
      // the resulting position back rather than guess it.
      queueMicrotask(() => {
        if (disposed) return;
        pinnedToBottomRef.current = terminalBottomOffset(term) === 0;
      });
    };
    const handleWheelCapture = (event: WheelEvent) => {
      applyScrollPinIntent(wheelScrollPinIntent(event.deltaY));
    };
    const handleKeyDownCapture = (event: KeyboardEvent) => {
      const intent = keyScrollPinIntent(event);
      applyScrollPinIntent(intent);
      // A backward viewport key with no scrollback to move into leaves the
      // viewport at the bottom, so read the result back instead of assuming
      // the key moved it. The wheel needs no equivalent: a wheel-up gesture
      // that cannot move produces no further events to correct.
      if (intent === "unpin") applyScrollPinIntent("resync");
    };
    surface.addEventListener("wheel", handleWheelCapture, { capture: true });
    surface.addEventListener("keydown", handleKeyDownCapture, { capture: true });

    const revealTerminal = async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (disposed) return;

      // Re-apply the current theme now that the container is visible.
      // Theme changes that occurred while hidden were deferred to avoid
      // corrupting xterm's scroll state; the renderer was deferred with them,
      // so reconcile it against the theme that is actually being installed.
      const currentTheme = useThemeStore.getState().theme;
      const rendererEntry = terminalCache.get(terminalId);
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

      const cachedEntry = terminalCache.get(terminalId);
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
      // Compute the offset here rather than on entry: the theme, settings and
      // fit work above can move the buffer, so an earlier snapshot is stale.
      resyncTerminalViewport(term, terminalBottomOffset(term));

      if (!attachedRef.current) {
        let attachRenderer: () => Promise<void>;
        const requestReattach = () => {
          inputEnabledRef.current = false;
          needsReattachRef.current = true;
          queueMicrotask(() => {
            if (!disposed && !reattachingRef.current && needsReattachRef.current) {
              void attachRenderer();
            }
          });
        };
        const installReplay = (replay: TerminalReplay, sequenceBoundary: number) => {
          inputEnabledRef.current = false;
          sequenceRef.current = sequenceBoundary;
          unregisterTerminal(terminalId);
          term.reset();
          term.resize(Math.max(2, replay.columns), Math.max(2, replay.rows));
          registerTerminal(
            terminalId,
            term,
            () => {
              if (pinnedToBottomRef.current) term.scrollToBottom();
              const descriptor = TERMINAL_CLIENT_RUNTIME.descriptor(terminalId);
              inputEnabledRef.current = descriptor?.lifecycle === "running";
            },
            requestReattach,
          );
          if (replay.bytes.length === 0) {
            const descriptor = TERMINAL_CLIENT_RUNTIME.descriptor(terminalId);
            inputEnabledRef.current = descriptor?.lifecycle === "running";
          } else {
            writeTerminalOutput(terminalId, replay.bytes);
          }
        };

        attachRenderer = async () => {
          if (disposed || reattachingRef.current) return;
          reattachingRef.current = true;
          const generation = ++attachmentGenerationRef.current;
          const previous = attachmentRef.current;
          attachmentRef.current = null;
          attachedRef.current = false;
          inputEnabledRef.current = false;
          needsReattachRef.current = false;
          unregisterTerminal(terminalId);
          if (previous) {
            await TERMINAL_CLIENT_RUNTIME.detach(previous.attachmentId).catch(() => undefined);
          }

          try {
            const attachment = await TERMINAL_CLIENT_RUNTIME.attach(
              terminalId,
              true,
              (event: TerminalEvent) => {
                if (disposed || attachmentGenerationRef.current !== generation) return;
                if (event.sequence !== sequenceRef.current + 1) {
                  requestReattach();
                  return;
                }
                sequenceRef.current = event.sequence;
                if (event.event === "output") {
                  writeTerminalOutput(terminalId, event.data);
                } else if (event.event === "replay") {
                  installReplay(event.replay, event.sequence);
                } else if (
                  event.event === "resync_required" ||
                  event.event === "detached"
                ) {
                  requestReattach();
                } else {
                  if (event.event === "exited") inputEnabledRef.current = false;
                }
              },
            );
            if (disposed || attachmentGenerationRef.current !== generation) {
              await TERMINAL_CLIENT_RUNTIME.detach(attachment.attachmentId).catch(() => undefined);
              return;
            }

            attachmentRef.current = attachment;
            const cached = terminalCache.get(terminalId);
            if (cached) cached.attachmentId = attachment.attachmentId;
            TERMINAL_CLIENT_RUNTIME.observeDescriptor(attachment.snapshot.descriptor);
            installReplay(
              attachment.snapshot.replay,
              attachment.snapshot.sequenceBoundary,
            );
            attachedRef.current = true;
            attachment.activate();
          } catch (error) {
            if (import.meta.env.DEV) {
              console.error("Failed to attach terminal renderer:", error);
            }
            useNoticeStore.getState().pushNotice({
              tone: "error",
              title: "Couldn’t attach terminal",
              message: getErrorMessage(error),
            });
          } finally {
            reattachingRef.current = false;
            if (needsReattachRef.current && !disposed) queueMicrotask(() => void attachRenderer());
          }
        };

        await attachRenderer();
        if (disposed) return;
        await fitAndResize();
      }

      window.setTimeout(() => {
        if (disposed) return;
        void fitAndResize();
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

    void revealTerminal();

    // ResizeObserver for auto-fitting. fitAndResize applies rows immediately
    // and owns the long-buffer column debounce.
    const observer = new ResizeObserver(() => {
      if (disposed) return;
      void fitAndResize();
    });
    observer.observe(containerRef.current);

    return () => {
      disposed = true;
      attachmentGenerationRef.current += 1;
      reattachingRef.current = false;
      const attachment = attachmentRef.current;
      attachmentRef.current = null;
      const cached = terminalCache.get(terminalId);
      if (cached) cached.attachmentId = null;
      attachedRef.current = false;
      inputEnabledRef.current = false;
      unregisterTerminal(terminalId);
      if (attachment) {
        void TERMINAL_CLIENT_RUNTIME.detach(attachment.attachmentId).catch(() => undefined);
      }
      observer.disconnect();
      surface.removeEventListener("wheel", handleWheelCapture, { capture: true });
      surface.removeEventListener("keydown", handleKeyDownCapture, { capture: true });
      if (columnResizeTimerRef.current) {
        clearTimeout(columnResizeTimerRef.current);
        columnResizeTimerRef.current = null;
      }
    };
  }, [terminalId, visible, getOrCreateTerminal, fitAndResize]);


  useEffect(() => {
    return () => {
      const cached = terminalCache.get(terminalId);
      if (cached) {
        cached.term.dispose();
        terminalCache.delete(terminalId);
        unregisterTerminal(terminalId);
      }
      mountedRef.current = false;
      attachedRef.current = false;
      pinnedToBottomRef.current = true;
      if (columnResizeTimerRef.current) {
        clearTimeout(columnResizeTimerRef.current);
        columnResizeTimerRef.current = null;
      }
    };
  }, [terminalId]);

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
