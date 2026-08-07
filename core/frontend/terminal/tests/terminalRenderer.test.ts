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

// The renderer set this build ships. xterm 6 has no canvas addon, so WebGL is
// the only addon-backed renderer left; "dom" needs no addon at all.
function accelerated(): TerminalRendererFactories {
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

test("glass themes use the DOM renderer and never WebGL", () => {
  const state = createTerminalRendererState();
  // WebGL paints cell backgrounds opaque, so it is not a glass candidate even
  // when it is the only accelerated renderer available.
  assert.equal(selectTerminalRenderer(GLASS, state, accelerated()), "dom");
  assert.equal(selectTerminalRenderer(GLASS, state, {}), "dom");
});

test("opaque themes take the accelerated path when it is available", () => {
  const state = createTerminalRendererState();
  assert.equal(selectTerminalRenderer(OPAQUE, state, accelerated()), "webgl");
  assert.equal(selectTerminalRenderer(OPAQUE, state, {}), "dom");
});

test("a failed renderer is not selected again", () => {
  const state = createTerminalRendererState();
  state.failedRenderers.add("webgl");
  assert.equal(selectTerminalRenderer(OPAQUE, state, accelerated()), "dom");
});

/* ── reconciliation ────────────────────────────────────── */

test("reconcile loads the selected addon once and is idempotent", () => {
  const term = fakeTerminal();
  const state = createTerminalRendererState();
  const factories = accelerated();

  assert.equal(reconcileTerminalRenderer(term, state, OPAQUE, factories), "webgl");
  assert.equal(term.loaded.length, 1);
  assert.equal(state.rendererKind, "webgl");
  assert.ok(state.rendererAddon);

  assert.equal(reconcileTerminalRenderer(term, state, OPAQUE, factories), "webgl");
  assert.equal(term.loaded.length, 1, "already-active renderer must not reload");
});

test("reconcile disposes the accelerated addon when a glass theme arrives", () => {
  const term = fakeTerminal();
  const state = createTerminalRendererState();
  const factories = accelerated();

  assert.equal(reconcileTerminalRenderer(term, state, OPAQUE, factories), "webgl");
  const webgl = state.rendererAddon as unknown as FakeAddon;

  assert.equal(reconcileTerminalRenderer(term, state, GLASS, factories), "dom");
  assert.equal(webgl.disposed, true);
  assert.equal(state.rendererAddon, null);
  assert.equal(state.rendererKind, "dom");
});

test("reconcile reloads the accelerated addon when an opaque theme returns", () => {
  const term = fakeTerminal();
  const state = createTerminalRendererState();
  const factories = accelerated();

  reconcileTerminalRenderer(term, state, OPAQUE, factories);
  reconcileTerminalRenderer(term, state, GLASS, factories);

  assert.equal(reconcileTerminalRenderer(term, state, OPAQUE, factories), "webgl");
  assert.equal(term.loaded.length, 2);
  assert.equal((state.rendererAddon as unknown as FakeAddon).disposed, false);
});

test("reconcile ends on the DOM renderer when the addon throws", () => {
  const term = fakeTerminal();
  const state = createTerminalRendererState();
  const factories: TerminalRendererFactories = {
    webgl: () => {
      throw new Error("no webgl context");
    },
  };

  assert.equal(reconcileTerminalRenderer(term, state, OPAQUE, factories), "dom");
  assert.equal(state.rendererAddon, null);
  assert.equal(state.failedRenderers.has("webgl"), true);
  assert.equal(term.loaded.length, 0);
});

test("reconcile does nothing before the terminal is mounted", () => {
  const term = fakeTerminal(false);
  const state = createTerminalRendererState();

  assert.equal(reconcileTerminalRenderer(term, state, OPAQUE, accelerated()), "dom");
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
