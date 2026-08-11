/**
 * The container half of a terminal view, without React.
 *
 * A terminal needs three things from the DOM: the size of its container, the
 * gestures the user makes over it, and the moment it is first on screen. Those
 * are facts about an element, not about a component, so they live here and the
 * component below is left holding refs and divs.
 *
 * The two lifetimes stay separate, as they were in the view. The binding — and
 * with it the session and the host attachment — belongs to the terminal, and
 * ends when the view stops representing that terminal. {@link
 * TerminalContainerBinding.reveal} is the visibility boundary and nothing more:
 * hiding a tab must not detach, because the attachment would have to be rebuilt
 * from a full replay on the way back, and everything the child printed
 * meanwhile would never reach the buffer.
 *
 * The session starts on the first reveal rather than at bind time. A
 * `display:none` container reports neither geometry nor scroll position, so
 * opening a surface against one measures nothing.
 */

import type { TerminalViewSession } from "./terminalViewSession.ts";

/** Cancels whatever the call that returned it started. */
export type Unbind = () => void;

/**
 * Everything the binding needs that a plain object cannot be.
 *
 * Each has a browser default, so production passes none of them. Tests pass
 * their own and observe the order of what follows.
 */
export interface TerminalContainerPorts {
  /** Open a session for this container. Called once, on the first reveal. */
  startSession(container: HTMLElement): TerminalViewSession;
  /** Release the terminal engine held for this view. */
  disposeEngine(): void;
  /** Report container size changes until the returned function is called. */
  observeResize(container: HTMLElement, onResize: () => void): Unbind;
  /** Deliver wheel and key gestures until the returned function is called. */
  observeGestures(container: HTMLElement, gestures: TerminalGestureSink): Unbind;
}

/** The gestures that move the reading position, before the surface sees them. */
export interface TerminalGestureSink {
  onWheel(deltaY: number): void;
  onKey(event: KeyboardEvent): void;
}

export interface TerminalContainerBinding {
  /**
   * The container is on screen. Opens the session the first time and catches
   * the surface up on every later call.
   */
  reveal(): void;
  /** The view no longer represents this terminal. */
  dispose(): void;
  /** Whether a session has been opened. For tests and diagnostics. */
  readonly started: boolean;
}

/** The part of `ResizeObserver` this adapter uses, and nothing more. */
export interface ResizeObserverLike {
  observe(target: HTMLElement): void;
  disconnect(): void;
}

/** Build an observer that calls back when the size it watches changes. */
export type ResizeObserverFactory = (onResize: () => void) => ResizeObserverLike;

/**
 * Watch an element for size changes. The browser default.
 *
 * The factory is a parameter so the adapter's own contract — observe once,
 * disconnect on unbind, never call back afterwards — is provable against a
 * structural fake. It is read at call time, so this module names no browser
 * global when it is merely loaded.
 */
export function observeResizeWithObserver(
  container: HTMLElement,
  onResize: () => void,
  createObserver: ResizeObserverFactory = (callback) => new ResizeObserver(callback),
): Unbind {
  const observer = createObserver(() => onResize());
  observer.observe(container);
  return () => observer.disconnect();
}

/**
 * Read gestures in the capture phase, before xterm consumes them. The browser
 * default.
 */
export function observeGesturesWithListeners(
  container: HTMLElement,
  gestures: TerminalGestureSink,
): Unbind {
  const onWheel = (event: WheelEvent) => gestures.onWheel(event.deltaY);
  const onKeyDown = (event: KeyboardEvent) => gestures.onKey(event);
  container.addEventListener("wheel", onWheel, { capture: true });
  container.addEventListener("keydown", onKeyDown, { capture: true });
  return () => {
    container.removeEventListener("wheel", onWheel, { capture: true });
    container.removeEventListener("keydown", onKeyDown, { capture: true });
  };
}

/**
 * Bind one container to one terminal.
 *
 * Observers are installed immediately, before any session exists, because a
 * container can be resized or scrolled while it is still hidden. Both sinks
 * therefore address the session through a live read rather than a captured
 * reference, and do nothing until there is one.
 */
export function bindTerminalContainer(
  container: HTMLElement,
  ports: TerminalContainerPorts,
): TerminalContainerBinding {
  let session: TerminalViewSession | null = null;
  let disposed = false;

  const unobserveResize = ports.observeResize(container, () => {
    void session?.requestFit();
  });
  const unobserveGestures = ports.observeGestures(container, {
    onWheel: (deltaY) => session?.pin.noteWheel(deltaY),
    onKey: (event) => session?.pin.noteKey(event),
  });

  return {
    get started() {
      return session !== null;
    },

    reveal() {
      if (disposed) return;
      if (session) {
        session.reveal();
        return;
      }
      session = ports.startSession(container);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      unobserveResize();
      unobserveGestures();
      session?.dispose();
      session = null;
      // The engine outlives the session so a reopened view can reuse its
      // buffer; nothing represents this terminal now, so it goes too.
      ports.disposeEngine();
    },
  };
}
