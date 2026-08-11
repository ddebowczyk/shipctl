/**
 * The lifecycle facts that used to sit inside `TerminalView.tsx`.
 *
 * Each one was previously reachable only through a JSX transform, a DOM and a
 * React renderer. They are asserted here against plain fakes, in the lane the
 * repository already has.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bindTerminalContainer,
  type TerminalContainerPorts,
  type TerminalGestureSink,
} from "../terminalContainerBinding.ts";
import type { TerminalViewSession } from "../terminalViewSession.ts";

class Harness {
  /** Every observable port effect, in order. The trace under assertion. */
  readonly trace: string[] = [];
  readonly ports: TerminalContainerPorts;
  /** The container stands in for an element; nothing reads it but the ports. */
  readonly container = {} as HTMLElement;

  #onResize: (() => void) | null = null;
  #gestures: TerminalGestureSink | null = null;
  #sessions = 0;

  constructor() {
    this.ports = {
      startSession: () => {
        this.#sessions += 1;
        const label = `session${this.#sessions}`;
        this.trace.push(`start:${label}`);
        return this.#fakeSession(label);
      },
      disposeEngine: () => {
        this.trace.push("engine:dispose");
      },
      observeResize: (_container, onResize) => {
        this.trace.push("resize:observe");
        this.#onResize = onResize;
        return () => {
          this.trace.push("resize:unobserve");
          this.#onResize = null;
        };
      },
      observeGestures: (_container, gestures) => {
        this.trace.push("gestures:observe");
        this.#gestures = gestures;
        return () => {
          this.trace.push("gestures:unobserve");
          this.#gestures = null;
        };
      },
    };
  }

  /** The container changed size. Throws if nothing is observing it. */
  resize(): void {
    assert.ok(this.#onResize, "the container is being observed");
    this.#onResize();
  }

  /** The user scrolled over the container. */
  wheel(deltaY: number): void {
    assert.ok(this.#gestures, "gestures are being delivered");
    this.#gestures.onWheel(deltaY);
  }

  /** The user typed over the container. */
  key(): void {
    assert.ok(this.#gestures, "gestures are being delivered");
    this.#gestures.onKey({ key: "a" } as KeyboardEvent);
  }

  /** Whether anything is still bound to the container. */
  get bound(): boolean {
    return this.#onResize !== null || this.#gestures !== null;
  }

  #fakeSession(label: string): TerminalViewSession {
    const trace = this.trace;
    return {
      pin: {
        noteWheel: (deltaY: number) => trace.push(`${label}:wheel:${deltaY}`),
        noteKey: () => trace.push(`${label}:key`),
      },
      reveal: () => trace.push(`${label}:reveal`),
      requestFit: () => {
        trace.push(`${label}:fit`);
        return Promise.resolve();
      },
      dispose: () => trace.push(`${label}:dispose`),
    } as unknown as TerminalViewSession;
  }
}

test("a hidden container is watched before any session exists", () => {
  const harness = new Harness();
  const binding = bindTerminalContainer(harness.container, harness.ports);

  assert.deepEqual(
    harness.trace,
    ["resize:observe", "gestures:observe"],
    "binding installs the observers and opens nothing: a display:none container " +
      "reports no geometry, so a surface opened against it measures nothing",
  );
  assert.equal(binding.started, false);

  // A container can be resized and scrolled while it is still hidden. Neither
  // may reach a session that does not exist, and neither may throw.
  harness.resize();
  harness.wheel(-3);
  harness.key();
  assert.deepEqual(harness.trace.slice(2), [], "no session, no effect");
});

test("the first reveal opens the session and every later one catches it up", () => {
  const harness = new Harness();
  const binding = bindTerminalContainer(harness.container, harness.ports);

  binding.reveal();
  assert.equal(binding.started, true);
  assert.deepEqual(harness.trace.slice(2), ["start:session1"]);

  binding.reveal();
  binding.reveal();
  assert.deepEqual(
    harness.trace.slice(3),
    ["session1:reveal", "session1:reveal"],
    "hiding and showing a tab reveals the session it kept; it never opens a " +
      "second one, because a re-attach would cost a full replay",
  );
});

test("gestures and resizes reach the session once it is open", () => {
  const harness = new Harness();
  const binding = bindTerminalContainer(harness.container, harness.ports);
  binding.reveal();
  harness.trace.length = 0;

  harness.resize();
  harness.wheel(-120);
  harness.key();

  assert.deepEqual(harness.trace, ["session1:fit", "session1:wheel:-120", "session1:key"]);
});

test("dispose unbinds the container, ends the session, then releases the engine", () => {
  const harness = new Harness();
  const binding = bindTerminalContainer(harness.container, harness.ports);
  binding.reveal();
  harness.trace.length = 0;

  binding.dispose();

  assert.deepEqual(
    harness.trace,
    ["resize:unobserve", "gestures:unobserve", "session1:dispose", "engine:dispose"],
    "the container stops producing events before the session that would " +
      "receive them goes away, and the engine outlives the session it served",
  );
  assert.equal(harness.bound, false, "nothing is left bound to the container");
});

test("a disposed binding is inert", () => {
  const harness = new Harness();
  const binding = bindTerminalContainer(harness.container, harness.ports);
  binding.reveal();
  binding.dispose();
  harness.trace.length = 0;

  binding.reveal();
  binding.dispose();

  assert.deepEqual(
    harness.trace,
    [],
    "a late reveal from an unmounting view opens no session, and a second " +
      "dispose releases the engine once",
  );
});

test("a container never revealed still tears down cleanly", () => {
  const harness = new Harness();
  const binding = bindTerminalContainer(harness.container, harness.ports);

  binding.dispose();

  assert.deepEqual(harness.trace.slice(2), ["resize:unobserve", "gestures:unobserve", "engine:dispose"]);
  assert.equal(harness.bound, false);
});
