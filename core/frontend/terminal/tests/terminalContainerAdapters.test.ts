/**
 * The two browser adapters, against structural fakes.
 *
 * Their whole body is "call the API, return an unbind", so what is theirs to
 * get wrong is narrow: which events they register, with which options, and
 * whether unbinding removes exactly what was added. That is asserted here.
 *
 * A DOM emulator is deliberately not used. It could not answer the questions
 * area 04 actually needs — occupancy, layout, hit testing, renderer fallback
 * are invisible without a layout engine and a GPU — and having one in the lane
 * would invite those questions to be answered in an engine whose answers do not
 * count. That is a second presentation authority, which is the shape this plan
 * exists to remove. Event ordering is the DOM's contract, not this module's;
 * what is this module's is that it asked for the capture phase.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  observeGesturesWithListeners,
  observeResizeWithObserver,
  type ResizeObserverLike,
} from "../terminalContainerBinding.ts";

interface Registration {
  type: string;
  listener: (event: never) => void;
  options: unknown;
}

/** An element that records listener traffic and can deliver an event. */
class FakeElement {
  readonly added: Registration[] = [];
  readonly removed: Registration[] = [];

  addEventListener(type: string, listener: (event: never) => void, options: unknown): void {
    this.added.push({ type, listener, options });
  }

  removeEventListener(type: string, listener: (event: never) => void, options: unknown): void {
    this.removed.push({ type, listener, options });
  }

  /** Deliver to whatever is currently registered for `type`. */
  dispatch(type: string, event: unknown): void {
    for (const registration of this.added) {
      if (registration.type !== type) continue;
      if (this.removed.some((entry) => entry.listener === registration.listener)) continue;
      registration.listener(event as never);
    }
  }

  get element(): HTMLElement {
    return this as unknown as HTMLElement;
  }
}

test("gestures are registered in the capture phase and forwarded", () => {
  const container = new FakeElement();
  const trace: string[] = [];

  observeGesturesWithListeners(container.element, {
    onWheel: (deltaY) => trace.push(`wheel:${deltaY}`),
    onKey: (event) => trace.push(`key:${event.key}`),
  });

  assert.deepEqual(
    container.added.map((entry) => entry.type),
    ["wheel", "keydown"],
    "the two gestures that move the reading position, and no others",
  );
  for (const entry of container.added) {
    assert.deepEqual(
      entry.options,
      { capture: true },
      "the capture phase is the point: the reading position is noted before " +
        "the surface under the container consumes the gesture",
    );
  }

  container.dispatch("wheel", { deltaY: -120 });
  container.dispatch("keydown", { key: "PageUp" });
  assert.deepEqual(trace, ["wheel:-120", "key:PageUp"]);
});

test("unbinding removes exactly what was added", () => {
  const container = new FakeElement();
  const trace: string[] = [];

  const unbind = observeGesturesWithListeners(container.element, {
    onWheel: () => trace.push("wheel"),
    onKey: () => trace.push("key"),
  });
  unbind();

  assert.deepEqual(
    container.removed,
    container.added,
    "same types, same function references, same capture flag — a listener " +
      "removed with a different phase or a fresh closure stays attached",
  );

  container.dispatch("wheel", { deltaY: 1 });
  container.dispatch("keydown", { key: "a" });
  assert.deepEqual(trace, [], "nothing is delivered after unbind");
});

test("the resize adapter observes once and disconnects on unbind", () => {
  const container = new FakeElement();
  const trace: string[] = [];
  let fire: (() => void) | null = null;

  const observer: ResizeObserverLike = {
    observe: (target) => {
      trace.push(target === container.element ? "observe:container" : "observe:other");
    },
    disconnect: () => trace.push("disconnect"),
  };

  const unbind = observeResizeWithObserver(
    container.element,
    () => trace.push("resize"),
    (callback) => {
      fire = callback;
      trace.push("create");
      return observer;
    },
  );

  assert.deepEqual(trace, ["create", "observe:container"]);

  assert.ok(fire, "the factory received the callback");
  fire();
  assert.deepEqual(trace.slice(2), ["resize"], "a size change reaches the caller");

  unbind();
  assert.deepEqual(trace.slice(3), ["disconnect"]);
});
