/**
 * Browser container lifetime for a semantic terminal presentation.
 *
 * A session starts only once its container is visible. Resize and gesture
 * observers exist for the full view lifetime, but do not create a session.
 */

import type { TerminalDisplaySession } from "./semanticTerminalViewSession.ts";

export type Unbind = () => void;

export interface TerminalGestureSink {
  onWheel(deltaY: number): void;
  onKey(event: KeyboardEvent): void;
}

export interface TerminalContainerPorts {
  startSession(container: HTMLElement): TerminalDisplaySession;
  disposeEngine(): void;
  observeResize(container: HTMLElement, onResize: () => void): Unbind;
  observeGestures(container: HTMLElement, gestures: TerminalGestureSink): Unbind;
}

export interface TerminalContainerBinding {
  reveal(): void;
  conceal(): void;
  dispose(): void;
  readonly started: boolean;
}

export interface ResizeObserverLike {
  observe(target: HTMLElement): void;
  disconnect(): void;
}

export type ResizeObserverFactory = (onResize: () => void) => ResizeObserverLike;

export function observeResizeWithObserver(
  container: HTMLElement,
  onResize: () => void,
  createObserver: ResizeObserverFactory = (callback) => new ResizeObserver(callback),
): Unbind {
  const observer = createObserver(() => onResize());
  observer.observe(container);
  return () => observer.disconnect();
}

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

export function bindTerminalContainer(
  container: HTMLElement,
  ports: TerminalContainerPorts,
): TerminalContainerBinding {
  let session: TerminalDisplaySession | null = null;
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
    conceal() {
      if (!disposed) session?.conceal();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unobserveResize();
      unobserveGestures();
      session?.dispose();
      session = null;
      ports.disposeEngine();
    },
  };
}
