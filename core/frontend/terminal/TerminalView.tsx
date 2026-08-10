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
import { openUrl } from "@shipctl/core/platform";
import { TerminalAttachmentController } from "./terminalAttachmentController.ts";
import {
  registerTerminal,
  unregisterTerminal,
  writeTerminalOutput,
} from "./terminalOutputQueue.ts";
import { TERMINAL_LINE_HEIGHT, buildCSSFontFamily } from "@shipctl/core/appearance";
import {
  preserveTerminalViewport,
  resolveViewportDrainAction,
  resyncTerminalViewport,
  terminalBottomOffset,
} from "./terminalViewport.ts";
import {
  keyScrollPinIntent,
  wheelScrollPinIntent,
  type ScrollPinIntent,
} from "./terminalScrollPin.ts";
import { createTerminalTheme } from "./terminalTheme.ts";
import { TRANSITIONAL_RENDERER_SCROLLBACK_ROWS } from "./terminalRetention.ts";
import { useThemeStore } from "@shipctl/core/appearance";
import { notifyAgent } from "./notifications.ts";
import { resolveKeybindingPreset } from "./keybindingPresets.ts";
import { parseOscNotificationMessage } from "./terminalOscNotification.ts";
import {
  COLUMN_REFLOW_SETTLE_MS,
  clampTerminalGeometry,
  planTerminalFit,
  type TerminalGeometry,
} from "./terminalFitPlan.ts";
import { useKeybindingStore } from "./useKeybindingStore.ts";
import { useTerminalSettingsStore } from "./useTerminalSettingsStore.ts";
import type { TerminalId } from "./types.ts";
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
  // The attachment protocol lives in the controller; the view only binds its
  // ports to xterm and reads it from the persistent terminal callbacks.
  const controllerRef = useRef<TerminalAttachmentController | null>(null);
  // Whether the viewport is following output. Tracked here rather than read
  // from xterm at write time: the queue writes in chunks across frames, so by
  // the time a chunk lands the buffer has already moved.
  const pinnedToBottomRef = useRef(true);
  // Distance from the end of the buffer that a pending replay has to restore.
  // Captured before the reset that discards it, applied when the replayed
  // bytes have drained.
  const pendingViewportRestoreRef = useRef<number | null>(null);
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

    // The one input path. The controller decides admission and returns a typed
    // outcome; the view only reacts to it.
    const submitInput = (data: string) => {
      void controllerRef.current?.submitInput(data).then((outcome) => {
        if (outcome.status === "unavailable") return;
        if (outcome.status === "accepted") {
          // Typing resumes follow mode; the response to this input is the thing
          // the user is waiting to see.
          pinnedToBottomRef.current = true;
          term.scrollToBottom();
          return;
        }
        if (import.meta.env.DEV) {
          console.error("Failed to write terminal input:", outcome.error);
        }
        useNoticeStore.getState().pushNotice({
          tone: "error",
          title: "Couldn’t write to terminal",
          message: getErrorMessage(outcome.error),
        });
      });
    };

    term.onData(submitInput);

    // Track terminal bell (attention request)
    term.onBell(() => {
      void notifyAgent(terminalId, "Terminal bell");
    });

    // Intercept OSC 9 notifications from coding agents (Claude Code, Codex, Gemini)
    term.parser.registerOscHandler(9, (data) => {
      const message = parseOscNotificationMessage(data);
      if (message) {
        void notifyAgent(terminalId, message);
      }
      return true;
    });

    // Intercept key combos for custom keybindings
    term.attachCustomKeyEventHandler((ev) => {
      const preset = resolveKeybindingPreset(
        useKeybindingStore.getState().settings,
        ev,
      );
      if (!preset) return true; // let xterm handle normally
      if (ev.type === "keydown") submitInput(preset.sequence);
      return false; // prevent xterm default handling
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

  const applyTerminalSize = useCallback(async (geometry: TerminalGeometry) => {
    const cached = terminalCache.get(terminalId);
    if (!cached) return;

    const size = clampTerminalGeometry(geometry);
    if (cached.term.cols === size.columns && cached.term.rows === size.rows) return;

    preserveTerminalViewport(cached.term, () => {
      cached.term.resize(size.columns, size.rows);
    });

    const attachmentId = controllerRef.current?.attachmentId;
    if (!attachmentId) return;
    await TERMINAL_CLIENT_RUNTIME.resize(
      terminalId,
      attachmentId,
      size.columns,
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

    const plan = planTerminalFit({
      current: { columns: cached.term.cols, rows: cached.term.rows },
      proposed: { columns: proposedSize.cols, rows: proposedSize.rows },
      bufferRows: cached.term.buffer.active.length,
    });
    if (plan.kind === "unchanged") return;

    const clearPendingColumnSettle = () => {
      if (columnResizeTimerRef.current) {
        clearTimeout(columnResizeTimerRef.current);
        columnResizeTimerRef.current = null;
      }
    };

    if (plan.kind === "resize") {
      clearPendingColumnSettle();
      await applyTerminalSize(plan.size);
      return;
    }

    if (plan.immediate) await applyTerminalSize(plan.immediate);
    clearPendingColumnSettle();
    const deferred = plan.deferred;
    columnResizeTimerRef.current = setTimeout(() => {
      columnResizeTimerRef.current = null;
      void applyTerminalSize(deferred);
    }, COLUMN_REFLOW_SETTLE_MS);
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

    // Bind the attachment protocol to this surface. Every port is a local
    // xterm, output-queue, or runtime operation; ordering and recovery belong
    // to the controller.
    const controller = new TerminalAttachmentController({
      attach: (onEvent) => TERMINAL_CLIENT_RUNTIME.attach(terminalId, true, onEvent),
      detach: (attachmentId) => TERMINAL_CLIENT_RUNTIME.detach(attachmentId),
      observeDescriptor: (descriptor) => {
        TERMINAL_CLIENT_RUNTIME.observeDescriptor(descriptor);
      },
      installReplay: (replay) => {
        unregisterTerminal(terminalId);
        // A replay rebuilds the buffer behind this reset, which zeroes the
        // scroll position. Remember how far from the end the user was reading
        // so the drain can put them back; a user already at the end is handled
        // by the pin and needs nothing remembered.
        const bottomOffset = terminalBottomOffset(term);
        pendingViewportRestoreRef.current = bottomOffset > 0 ? bottomOffset : null;
        term.reset();
        const replaySize = clampTerminalGeometry({
          columns: replay.columns,
          rows: replay.rows,
        });
        term.resize(replaySize.columns, replaySize.rows);
        registerTerminal(
          terminalId,
          term,
          () => {
            // The queue reports a drain only when it has emptied, so the
            // replayed buffer is whole by the time this runs.
            const action = resolveViewportDrainAction({
              pinnedToBottom: pinnedToBottomRef.current,
              pendingBottomOffset: pendingViewportRestoreRef.current,
              baseY: term.buffer.active.baseY,
            });
            pendingViewportRestoreRef.current = null;
            if (action.kind === "bottom") term.scrollToBottom();
            else if (action.kind === "line") term.scrollToLine(action.line);
            controller.noteOutputDrained();
          },
          () => controller.requestRecovery(),
        );
      },
      stopOutput: () => unregisterTerminal(terminalId),
      releaseOutput: (bytes) => writeTerminalOutput(terminalId, bytes),
      acceptsInput: () =>
        TERMINAL_CLIENT_RUNTIME.descriptor(terminalId)?.lifecycle === "running",
      write: (data) => TERMINAL_CLIENT_RUNTIME.write(terminalId, data),
      publishAttachmentId: (attachmentId) => {
        const cached = terminalCache.get(terminalId);
        if (cached) cached.attachmentId = attachmentId;
      },
      reportError: (error) => {
        if (import.meta.env.DEV) {
          console.error("Failed to attach terminal renderer:", error);
        }
        useNoticeStore.getState().pushNotice({
          tone: "error",
          title: "Couldn’t attach terminal",
          message: getErrorMessage(error),
        });
      },
    });
    controllerRef.current = controller;

    const surface = containerRef.current;
    const applyScrollPinIntent = (intent: ScrollPinIntent) => {
      // A gesture during a replay supersedes the position that replay was
      // going to restore.
      pendingViewportRestoreRef.current = null;
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

      // Re-apply terminal settings (font, cursor) that may have
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

      await controller.start();
      if (disposed) return;
      await fitAndResize();

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
      controller.dispose();
      controllerRef.current = null;
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
      pinnedToBottomRef.current = true;
      pendingViewportRestoreRef.current = null;
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
