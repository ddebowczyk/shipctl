import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createTerminalRendererState,
  reconcileTerminalRenderer,
  selectTerminalRenderer,
  type TerminalRendererFactories,
} from "../terminalRenderer.ts";

const GLASS = { isTransparent: true };
const OPAQUE = { isTransparent: false };

// The renderer set the app ships on xterm 5, and the set it is left with once
// the canvas addon — which has no xterm 6 build — is dropped.
function withCanvas(): TerminalRendererFactories {
  return { canvas: () => fakeAddon(), webgl: () => fakeAddon() };
}

function withoutCanvas(): TerminalRendererFactories {
  return { webgl: () => fakeAddon() };
}

interface FakeAddon {
  activate(): void;
  dispose(): void;
  disposed: boolean;
  onContextLoss?: (handler: () => void) => void;
}

function fakeAddon(overrides: Partial<FakeAddon> = {}): FakeAddon {
  const addon: FakeAddon = {
    disposed: false,
    activate() {},
    dispose() {
      addon.disposed = true;
    },
    ...overrides,
  };
  return addon;
}

function fakeTerminal(mounted = true) {
  const loaded: FakeAddon[] = [];
  return {
    element: mounted ? ({} as HTMLElement) : undefined,
    loadAddon(addon: FakeAddon) {
      loaded.push(addon);
    },
    loaded,
  };
}

/* ── selection policy ──────────────────────────────────── */

test("glass themes prefer canvas while it ships, and never webgl", () => {
  const state = createTerminalRendererState();
  assert.equal(selectTerminalRenderer(GLASS, state, withCanvas()), "canvas");
  // WebGL paints cell backgrounds opaque, so it is not a glass candidate even
  // when it is the only accelerated renderer left.
  assert.equal(selectTerminalRenderer(GLASS, state, withoutCanvas()), "dom");
});

test("glass themes fall to the DOM renderer once canvas is gone", () => {
  const state = createTerminalRendererState();
  assert.equal(selectTerminalRenderer(GLASS, state, {}), "dom");
});

test("opaque themes keep the canvas-then-webgl accelerated path", () => {
  const state = createTerminalRendererState();
  assert.equal(selectTerminalRenderer(OPAQUE, state, withCanvas()), "canvas");
  assert.equal(selectTerminalRenderer(OPAQUE, state, withoutCanvas()), "webgl");
  assert.equal(selectTerminalRenderer(OPAQUE, state, {}), "dom");
});

test("a failed renderer is not selected again", () => {
  const state = createTerminalRendererState();
  state.failedRenderers.add("canvas");
  assert.equal(selectTerminalRenderer(OPAQUE, state, withCanvas()), "webgl");
  state.failedRenderers.add("webgl");
  assert.equal(selectTerminalRenderer(OPAQUE, state, withCanvas()), "dom");
});

/* ── reconciliation ────────────────────────────────────── */

test("reconcile loads the selected addon once and is idempotent", () => {
  const term = fakeTerminal();
  const state = createTerminalRendererState();
  const factories = withCanvas();

  assert.equal(reconcileTerminalRenderer(term, state, OPAQUE, factories), "canvas");
  assert.equal(term.loaded.length, 1);
  assert.equal(state.rendererKind, "canvas");
  assert.ok(state.rendererAddon);

  assert.equal(reconcileTerminalRenderer(term, state, OPAQUE, factories), "canvas");
  assert.equal(term.loaded.length, 1, "already-active renderer must not reload");
});

test("reconcile disposes the previous addon when the theme changes", () => {
  const term = fakeTerminal();
  const state = createTerminalRendererState();
  // Canvas is absent, so opaque lands on WebGL and glass must shed it.
  const factories = withoutCanvas();

  assert.equal(reconcileTerminalRenderer(term, state, OPAQUE, factories), "webgl");
  const webgl = state.rendererAddon as unknown as FakeAddon;

  assert.equal(reconcileTerminalRenderer(term, state, GLASS, factories), "dom");
  assert.equal(webgl.disposed, true);
  assert.equal(state.rendererAddon, null);
  assert.equal(state.rendererKind, "dom");
});

test("reconcile falls through renderers that throw on construction", () => {
  const term = fakeTerminal();
  const state = createTerminalRendererState();
  const factories: TerminalRendererFactories = {
    canvas: () => {
      throw new Error("no 2d context");
    },
    webgl: () => fakeAddon(),
  };

  assert.equal(reconcileTerminalRenderer(term, state, OPAQUE, factories), "webgl");
  assert.equal(state.failedRenderers.has("canvas"), true);
  assert.equal(term.loaded.length, 1);
});

test("reconcile ends on the DOM renderer when every addon fails", () => {
  const term = fakeTerminal();
  const state = createTerminalRendererState();
  const factories: TerminalRendererFactories = {
    canvas: () => {
      throw new Error("no 2d context");
    },
    webgl: () => {
      throw new Error("no webgl context");
    },
  };

  assert.equal(reconcileTerminalRenderer(term, state, OPAQUE, factories), "dom");
  assert.equal(state.rendererAddon, null);
  assert.equal(term.loaded.length, 0);
});

test("reconcile does nothing before the terminal is mounted", () => {
  const term = fakeTerminal(false);
  const state = createTerminalRendererState();

  assert.equal(reconcileTerminalRenderer(term, state, OPAQUE, withCanvas()), "dom");
  assert.equal(term.loaded.length, 0);
  assert.equal(state.failedRenderers.size, 0, "an unmounted terminal must not burn candidates");
});

test("webgl context loss drops to DOM and is not retried", () => {
  const term = fakeTerminal();
  const state = createTerminalRendererState();
  let lose: (() => void) | null = null;
  const factories: TerminalRendererFactories = {
    webgl: () =>
      fakeAddon({
        onContextLoss(handler: () => void) {
          lose = handler;
        },
      }),
  };

  assert.equal(reconcileTerminalRenderer(term, state, OPAQUE, factories), "webgl");
  const webgl = state.rendererAddon as unknown as FakeAddon;

  assert.ok(lose, "webgl addon must be given a context-loss handler");
  (lose as unknown as () => void)();

  assert.equal(webgl.disposed, true);
  assert.equal(state.rendererKind, "dom");
  assert.equal(state.failedRenderers.has("webgl"), true);

  assert.equal(reconcileTerminalRenderer(term, state, OPAQUE, factories), "dom");
  assert.equal(term.loaded.length, 1, "a lost renderer must not be reloaded");
});
