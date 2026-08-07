import type { ITerminalAddon, Terminal } from "@xterm/xterm";
import type { ShepTheme } from "@shep/core/appearance";

// The terminal engine seam: which xterm renderer drives a terminal, and how the
// app moves between renderers when the theme changes or a renderer fails.
//
// This module is deliberately free of value imports from the xterm addon
// bundles so the capability's logic entry point — and therefore the node --test
// lanes — can import it. The concrete addon constructors live in
// "./terminalRendererAddons.ts" and are handed in as factories.

/**
 * Renderer strategies a terminal can run on.
 *
 * "dom" is xterm's own built-in renderer: it needs no addon, so it is always
 * reachable and is the last entry of every preference chain.
 */
export type TerminalRendererKind = "canvas" | "webgl" | "dom";

/** The slice of an xterm renderer addon this capability actually drives. */
export type TerminalRendererAddon = ITerminalAddon & {
  clearTextureAtlas?: () => void;
  onContextLoss?: (handler: () => void) => unknown;
};

/**
 * Constructors for the addon-backed renderers.
 *
 * A missing entry means that renderer is not available in this build. That is
 * the intended lever: removing `canvas` here is the whole change needed to move
 * the app onto the post-canvas renderer set, and both sets are covered by tests.
 */
export interface TerminalRendererFactories {
  canvas?: () => TerminalRendererAddon;
  webgl?: () => TerminalRendererAddon;
}

/** Per-terminal renderer bookkeeping, carried on the terminal cache entry. */
export interface TerminalRendererState {
  rendererAddon: TerminalRendererAddon | null;
  rendererKind: TerminalRendererKind;
  failedRenderers: Set<TerminalRendererKind>;
}

/** The part of a terminal the renderer seam touches. */
export type TerminalRendererTarget = Pick<Terminal, "element" | "loadAddon">;

type RendererTheme = Pick<ShepTheme, "isTransparent">;

// Glass themes composite over Shep's gradient and the native window effect, so
// their renderer must leave cell backgrounds unpainted. WebGL paints an opaque
// rectangle instead, which is why it is absent from this chain.
const GLASS_PREFERENCE: readonly TerminalRendererKind[] = ["canvas", "dom"];

// Opaque themes keep the accelerated path the app has always used: Canvas
// first, WebGL when Canvas is unavailable.
const OPAQUE_PREFERENCE: readonly TerminalRendererKind[] = ["canvas", "webgl", "dom"];

export function createTerminalRendererState(): TerminalRendererState {
  return { rendererAddon: null, rendererKind: "dom", failedRenderers: new Set() };
}

export function terminalRendererPreference(
  theme: RendererTheme,
): readonly TerminalRendererKind[] {
  return theme.isTransparent ? GLASS_PREFERENCE : OPAQUE_PREFERENCE;
}

/**
 * The renderer a terminal should be running, given the theme, the renderers
 * this build ships, and the ones that have already failed on this terminal.
 */
export function selectTerminalRenderer(
  theme: RendererTheme,
  state: Pick<TerminalRendererState, "failedRenderers">,
  factories: TerminalRendererFactories,
): TerminalRendererKind {
  for (const kind of terminalRendererPreference(theme)) {
    if (kind === "dom") break;
    if (state.failedRenderers.has(kind)) continue;
    if (!factories[kind]) continue;
    return kind;
  }
  return "dom";
}

let activeFactories: TerminalRendererFactories = {};

/**
 * Install the renderer addon constructors. Until this is called every terminal
 * resolves to the DOM renderer, which is the correct degradation for any
 * context that has no xterm addon bundle loaded.
 */
export function setTerminalRendererFactories(factories: TerminalRendererFactories): void {
  activeFactories = factories;
}

export function getTerminalRendererFactories(): TerminalRendererFactories {
  return activeFactories;
}

function warnRenderer(message: string, error?: unknown): void {
  if (!import.meta.env?.DEV) return;
  console.warn(message, error);
}

function dropRendererAddon(state: TerminalRendererState): void {
  const addon = state.rendererAddon;
  state.rendererAddon = null;
  state.rendererKind = "dom";
  addon?.dispose();
}

/**
 * Bring a terminal's renderer in line with the theme, disposing whatever was
 * loaded before and marking any renderer that fails so it is not retried.
 *
 * Returns the renderer the terminal ended up on.
 */
export function reconcileTerminalRenderer(
  term: TerminalRendererTarget,
  state: TerminalRendererState,
  theme: RendererTheme,
  factories: TerminalRendererFactories = getTerminalRendererFactories(),
): TerminalRendererKind {
  // Renderer addons reach into the terminal's DOM, so there is nothing to
  // reconcile before open(). The caller reconciles again once mounted.
  if (!term.element) return state.rendererKind;

  // Each failed attempt is recorded before re-selecting, so the candidate set
  // strictly shrinks and this terminates on "dom".
  for (;;) {
    const desired = selectTerminalRenderer(theme, state, factories);
    if (desired === "dom") break;
    if (desired === state.rendererKind && state.rendererAddon) return desired;

    dropRendererAddon(state);

    const factory = factories[desired];
    if (!factory) {
      state.failedRenderers.add(desired);
      continue;
    }

    try {
      const addon = factory();
      addon.onContextLoss?.(() => {
        if (state.rendererAddon !== addon) return;
        state.failedRenderers.add(desired);
        dropRendererAddon(state);
        warnRenderer(`${desired} renderer context lost; using xterm's DOM renderer`);
      });
      term.loadAddon(addon);
      state.rendererAddon = addon;
      state.rendererKind = desired;
      return desired;
    } catch (error) {
      state.failedRenderers.add(desired);
      warnRenderer(`${desired} renderer unavailable:`, error);
    }
  }

  dropRendererAddon(state);
  return "dom";
}
