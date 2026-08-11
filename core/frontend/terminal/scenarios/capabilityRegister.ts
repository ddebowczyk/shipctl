/**
 * Every terminal capability, and how its disposition is proven.
 *
 * This is area 04's second acceptance criterion, and it is what stops the
 * scenario harness from becoming a demo. Without it, coverage is whatever
 * somebody happened to write a scenario for — parity by assertion, which is the
 * failure area 04 opens by forbidding. With it, the scenarios are a checklist
 * that a test can hold the harness to.
 *
 * The register is deliberately data. It needs no browser, no owner decision and
 * no running app to be written, reviewed, or diffed.
 *
 * ## The four dispositions
 *
 * - `implemented` — the product has it and something proves it.
 * - `blocking` — the product has it, the semantic surface does not yet. It
 *   blocks the area-05 cutover.
 * - `changed` — the product's behaviour changes deliberately. Requires a named
 *   owner and the contract that records the decision.
 * - `absent` — not in the current product. Not a migration obligation. Adding
 *   one here because xterm could support it is how scope grows silently.
 *
 * ## What no scenario can prove
 *
 * A self-driven scenario proves that something ran, did not throw, and produced
 * the numbers recorded beside it. It cannot prove the result was *right* to a
 * reader: that a combining mark sits on the correct base glyph, that a fallback
 * font is legible, that composed text appeared as the writer intended. Those
 * entries are `manual` and stay `manual`. A person perceiving a glyph is the
 * acceptance test, and no amount of harness removes them from it.
 */

import type { ScenarioId } from "./scenarioContract.ts";

export type CapabilityDisposition = "implemented" | "blocking" | "changed" | "absent";

/**
 * How a disposition is backed.
 *
 * - `lane` — a `node --test` fact. Named by test file, so it is greppable.
 * - `scenario` — a packaged-app scenario, by id.
 * - `manual` — a recorded human observation. The named procedure says what the
 *   person must look at.
 * - `none` — admissible only for `blocking` and `absent`, where there is by
 *   definition nothing to prove.
 */
export type CapabilityProof =
  | { by: "lane"; test: string }
  | { by: "scenario"; id: ScenarioId }
  | { by: "manual"; procedure: string }
  | { by: "none" };

export interface CapabilityEntry {
  readonly id: string;
  readonly capability: string;
  readonly disposition: CapabilityDisposition;
  readonly proof: CapabilityProof;
  /** Required for `changed`: who decided. */
  readonly owner?: string;
  /**
   * Required for `changed`: the file that records the decision.
   *
   * A name on its own is an assertion that somebody agreed. The record is what
   * a reader can check, and what stops an entry from approving itself.
   */
  readonly decision?: string;
  readonly note?: string;
}

/**
 * The register.
 *
 * Coverage follows area 04's own enumeration rather than the shape of the code,
 * so a capability the implementation forgot still appears here with nothing
 * proving it.
 */
export const TERMINAL_CAPABILITY_REGISTER: readonly CapabilityEntry[] = [
  // ---- Screen, cursor and geometry -------------------------------------
  {
    id: "screen.active",
    capability: "Active screen renders host rows",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalCellPresenter.test.ts" },
    note: "The webview builds the semantic surface now — "
      + "terminalBrowserSession.ts's WEBVIEW_TERMINAL_TRANSPORT — so the rows a "
      + "person sees are the host's projection through the model, and no xterm "
      + "buffer is read to draw them. What no lane reaches is the binding that "
      + "mounts it, because this suite has no webview; measure.sustained-output "
      + "is where a mounted one is measured.",
  },
  {
    id: "screen.alternate",
    capability: "Alternate screen enters, renders and restores",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalCellPaint.test.ts" },
    note: "Entering and leaving is the host's own screen state, asserted "
      + "against a real child in runtime.rs and against the pinned parser in "
      + "compat.rs::the_alternate_screen_leaves_the_primary_screen_intact. The "
      + "client is told which screen it is looking at and paints that; it keeps "
      + "no second buffer to restore from.",
  },
  {
    id: "cursor.shape",
    capability: "Cursor shape, blink and visibility follow host state",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalCellPaint.test.ts" },
    note: "The shape and whether it blinks are Ghostty's own render state, "
      + "projected by projection.rs::"
      + "the_shape_the_child_asked_for_is_the_shape_the_client_is_told, so a "
      + "DECSCUSR the child sent decides it and nothing on the client does. The "
      + "plan carries the shape and which half of the blink this frame is; the "
      + "canvas draws each shape with the display's own hairline "
      + "(tests/terminalCanvasTarget.test.ts); the presenter keeps the clock "
      + "and relights a cursor that moved, so typing is never under a dark one "
      + "(tests/terminalCellPresenter.test.ts). The rate is the one the product "
      + "blinks at today — @xterm/addon-webgl restarts at 600 ms — because "
      + "parity is the authority and the host says only whether, never when.",
  },
  {
    id: "geometry.fit",
    capability: "Container pixels resolve to a column and row count",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalMeasure.test.ts" },
  },
  {
    id: "geometry.resize",
    capability: "A resized container refits and tells the PTY once",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalFitScheduler.test.ts" },
  },
  {
    id: "geometry.cell-metrics",
    capability: "The pixel size of one cell is measured from the font, without "
      + "building a terminal to ask",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalFontMetrics.test.ts" },
    note: "The measurement the surface sizes itself with. It decides pixels per "
      + "cell only; how many cells a grapheme occupies stays the host's answer, "
      + "which is what keeps this from being a second VT in miniature.",
  },
  {
    id: "geometry.wrap",
    capability: "Wrap and reflow follow host columns, not measured text",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalSemanticSurface.test.ts" },
    note: "The surface production binds holds no buffer to reflow: a resize "
      + "changes nothing locally and the host's next frame is the new shape. "
      + "Where a line wrapped is the host's answer, carried in the rows it "
      + "sends.",
  },

  // ---- Unicode occupancy ------------------------------------------------
  {
    id: "unicode.occupancy",
    capability: "Painter never widens or narrows a host-supplied span",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalCellSurface.test.ts" },
    note: "The spans the product draws are the host's now: a wide grapheme is "
      + "two columns because the host said wide, and the canvas places one "
      + "glyph per host cell at the plan's advance rather than letting the "
      + "browser shape a run. Nothing on this path calls wcwidth, a Unicode "
      + "table, Intl.Segmenter or measureText.",
  },
  {
    id: "unicode.glyph-fits-span",
    capability: "Combining marks, wide cells, variation and joiner sequences "
      + "render legibly inside the host span, including under font fallback",
    disposition: "blocking",
    proof: { by: "manual", procedure: "docs/ops/terminal-glyph-review.md" },
    note: "Not falsifiable by a scenario. A scenario can prove the corpus "
      + "painted without throwing; only a reader can prove it looked right.",
  },

  // ---- The presentation decision, apart from whatever draws it ----------
  {
    id: "paint.plan-from-host-state",
    capability: "One frame of host state becomes a renderer-independent paint "
      + "plan: runs, colours, cursor and damage, in host columns and pixels",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalCellPaint.test.ts" },
    note: "This is area 04's narrow presentation interface. It is what a "
      + "Canvas, WebGL or DOM surface consumes, and it is where the two rules "
      + "live that keep a surface presentation-only: spans come from the host "
      + "cell, and modes stay in the model.",
  },
  {
    id: "paint.draw-sequence",
    capability: "A plan becomes an ordered sequence of six drawing operations, "
      + "with colours resolved and the chrome supplying only what the child "
      + "left unsaid",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalCellSurface.test.ts" },
    note: "Order, reverse video, selection colour and what a partial frame "
      + "leaves alone are decided in a module that loads in bare node. What "
      + "the browser-only binding adds is turning six calls into pixels.",
  },
  {
    id: "paint.frame-lifecycle",
    capability: "Model changes become frames: coalesced, with the damage of "
      + "every collapsed frame still painted, suspended while hidden, and "
      + "full again whenever the pixels are not the last frame's",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalCellPresenter.test.ts" },
    note: "The presentation lifecycle, held apart from both the model and the "
      + "painter. Disposing it loses pixels and nothing else, which is what "
      + "makes hide, show and recreate cheap.",
  },
  {
    id: "paint.canvas-binding",
    capability: "The six drawing operations become Canvas 2D calls: a backing "
      + "store in device pixels, one glyph per host cell at the plan's advance, "
      + "and a hairline link decoration",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalCanvasTarget.test.ts" },
    note: "The context is named structurally, so this binding is proved in the "
      + "node lane rather than assumed. It is what the product paints with "
      + "now; the seven operations include the cursor, whose shape decides how "
      + "much of the cell is filled.",
  },
  {
    id: "surface.semantic",
    capability: "A view session drives the model, the plan and the canvas "
      + "through the surface interface it already speaks",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalSemanticSurface.test.ts" },
    note: "The peer of the xterm surface, and the first module on this path "
      + "with no engine under it: the screen's size is the host's, a local "
      + "resize does nothing, no buffer is reflowed, and local input leaves as "
      + "what a person did. It is production now: the composition root builds "
      + "it for every webview terminal, and the entries below are read against "
      + "a surface a person actually uses.",
  },
  {
    id: "paint.hit-test",
    capability: "A surface pixel resolves to the host cell that owns it, "
      + "including both columns of a wide grapheme",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalCellPaint.test.ts" },
    note: "The address a click, a selection edge or a link hit is expressed "
      + "in. Selection meaning itself stays with the host.",
  },

  // ---- Colour, theme and font ------------------------------------------
  {
    id: "theme.resolved-colors",
    capability: "Resolved semantic colours reach the surface",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalTheme.test.ts" },
  },
  {
    id: "theme.change-repaints",
    capability: "A theme or font change repaints without replay or re-attach",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalViewSession.test.ts" },
    note: "Two ways in, both proved: a terminal revealed collects the current "
      + "theme and settings itself, and a terminal already on screen is told. "
      + "The global appliers reach the byte path through the engine cache and "
      + "the semantic path through the live sessions, because a semantic "
      + "terminal keeps no engine there. A font change carries the fit with "
      + "it, so the host learns the new column and row count.",
  },
  {
    id: "theme.webfont-remeasure",
    capability: "A webfont landing after first paint re-measures the grid",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalViewSession.test.ts" },
  },

  // ---- Surface lifecycle -------------------------------------------------
  {
    id: "lifecycle.hide-show",
    capability: "Hiding a tab does not detach; showing it catches up",
    disposition: "implemented",
    proof: {
      by: "lane",
      test: "core/frontend/terminal/tests/terminalContainerBinding.test.ts",
    },
  },
  {
    id: "lifecycle.teardown",
    capability: "Leaving a terminal unbinds the container, ends the session "
      + "and releases the engine, in that order",
    disposition: "implemented",
    proof: {
      by: "lane",
      test: "core/frontend/terminal/tests/terminalContainerBinding.test.ts",
    },
  },
  {
    id: "lifecycle.viewport-preserved",
    capability: "The reading position survives replay, resize and reveal",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalViewportPin.test.ts" },
  },
  {
    id: "lifecycle.renderer-recreation",
    capability: "Recreating the renderer preserves model identity",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalCellPresenter.test.ts" },
    note: "The presenter holds no terminal state: disposing one loses pixels "
      + "and nothing else, and the next one paints the model in full. The "
      + "model is the terminal's continuity and it outlives every surface, "
      + "which is why hide, show and recreate are all the same cheap thing.",
  },

  // ---- Renderer and fallback --------------------------------------------
  {
    id: "renderer.selection",
    capability: "The primary painter is selected from measured evidence",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalRenderer.test.ts" },
  },
  {
    id: "renderer.primary-failure-recovery",
    capability: "A primary-painter failure leaves a usable terminal, with no "
      + "second model and no xterm fallback",
    disposition: "blocking",
    proof: { by: "scenario", id: "renderer.primary-failure" },
    note: "The scenario injects a Canvas2D painter failure and requires a full "
      + "repaint from the same model. Blocking until it has "
      + "been run in the packaged app and the numbers are recorded.",
  },

  // ---- Input --------------------------------------------------------------
  {
    id: "input.semantic-mapping",
    capability: "A browser keyboard, pointer, composition or focus event "
      + "becomes the host's own input value, with no escape sequence chosen "
      + "on the client side",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalSemanticInput.test.ts" },
    note: "The input half of paint.plan-from-host-state, and proved the same "
      + "way: against terminalInputFixture.json, which the host writes from "
      + "its own Rust types.",
  },
  {
    id: "input.semantic-transport",
    capability: "A client submits that value to the host, which encodes it "
      + "from the modes the child selected and answers what it became",
    disposition: "implemented",
    proof: {
      by: "lane",
      test: "core/frontend/terminal/tests/terminalAttachmentController.test.ts",
    },
    note: "The path is open end to end — adapter, runtime, Tauri command, "
      + "control socket and CLI — and the surface that uses it is the one the "
      + "product builds.",
  },
  {
    id: "input.keyboard",
    capability: "Keystrokes reach the host as semantic input",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalSemanticSurface.test.ts" },
    note: "No encoder runs on the client: a keystroke leaves as what the "
      + "person pressed and the host encodes it from the modes the child "
      + "selected. The keys land in a text area rather than on the canvas, "
      + "because a canvas receives no paste and no composition, and a composing "
      + "key is reported as composing instead of refusing the browser default "
      + "the input method needs.",
  },
  {
    id: "input.keybindings",
    capability: "Application keybindings resolve before the terminal sees them",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/keybindingPresets.test.ts" },
  },
  {
    id: "input.gesture-capture",
    capability: "Wheel and key gestures are read before the surface consumes them",
    disposition: "implemented",
    proof: {
      by: "lane",
      test: "core/frontend/terminal/tests/terminalContainerAdapters.test.ts",
    },
  },
  {
    id: "input.ime",
    capability: "Composed text via a real input method commits correctly",
    disposition: "blocking",
    proof: { by: "manual", procedure: "docs/ops/terminal-ime-review.md" },
    note: "Not falsifiable by a scenario. Synthetic composition events prove "
      + "the handler, not the input method. The semantic surface now has "
      + "a cursor-positioned editing host, visible pre-edit presentation, "
      + "cancellation, and exact-once semantic commit. The packaged review "
      + "must still prove the real input method and candidate window.",
  },
  {
    id: "input.paste",
    capability: "Paste intent delivers clipboard text once",
    disposition: "blocking",
    proof: { by: "manual", procedure: "docs/ops/terminal-interaction-review.md" },
    note: "The optional confirmUnsafePaste setting defaults to false. When it "
      + "is enabled, the browser asks the host classifier and holds unsafe "
      + "text for Paste or Cancel. Focused tests prove the disabled, safe, "
      + "accepted, cancelled, and failed-classification paths. The packaged "
      + "interaction review remains.",
  },
  {
    id: "input.pointer-selection",
    capability: "Press, drag, release, multi-click and autoscroll select cells",
    disposition: "implemented",
    proof: {
      by: "lane",
      test: "core/frontend/terminal/tests/terminalSelectionGestures.test.ts",
    },
    note: "Press, drag, release, shift-extend, rectangle, the platform's own "
      + "multi-click and now autoscroll all become the host's selection "
      + "requests, in tests/terminalSelectionGestures.test.ts and "
      + "tests/terminalPointerRouter.test.ts. Every request names screen space "
      + "— history and the active area together — because the hit test reads "
      + "what is displayed, so a reader scrolled back selects the rows in front "
      + "of them. A drag held past the edge spends its overshoot divided by the "
      + "measured cell as whole rows per frame, each row one scroll and one "
      + "{kind:extend} the host resolves; a frame whose history rows have not "
      + "arrived is waited for, not read as the end of the drag. The router "
      + "the product binds is this one.",
  },
  {
    id: "selection.copy",
    capability: "The selected text reaches the clipboard by the platform's own "
      + "copy gesture",
    disposition: "blocking",
    proof: { by: "manual", procedure: "docs/ops/terminal-interaction-review.md" },
    note: "Enumerated late: the product has it through xterm, and no entry "
      + "named it. The host is the only place the text exists — it unwraps a "
      + "wrapped line — so the semantic surface holds the text the selection "
      + "answer returned in its focused text area, selected. Which gesture "
      + "copies stays the platform's, and this client reads no shortcut and "
      + "writes to no clipboard. A person must confirm the platform gesture "
      + "and wrapped-line result with the packaged interaction procedure.",
  },
  {
    id: "input.mouse-reporting",
    capability: "Mouse modes, wheel and modifiers reach the child",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalPointerRouter.test.ts" },
    note: "Buttons, motion, modifiers and now the wheel all reach the child "
      + "through the router when the host reports mouseTracking, in "
      + "tests/terminalPointerRouter.test.ts. A terminal has "
      + "no scroll message: the wheel is buttons four to seven, pressed and "
      + "never released, which "
      + "compat.rs::the_wheel_encodes_as_the_buttons_the_scroll_flag_names "
      + "asserts against the pinned parser, which runtime.rs writes to a real "
      + "child, and which the mouse-wheel-* samples of terminalInputFixture.json "
      + "carry to the client. One press per step, fractions kept, and shift "
      + "reaches past the child as it does for a selection. The canvas the "
      + "product paints on is where these events are taken. What no lane "
      + "reaches is a real full-screen program changing modes under a person's "
      + "hand.",
  },
  {
    id: "input.focus",
    capability: "Focus and blur reach the host",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalSemanticInput.test.ts" },
    note: "Both directions leave as focus-gained and focus-lost, and the host "
      + "reports them to the child only if the child asked. The text area is "
      + "what gains and loses focus, and it carries the Tab stop the product "
      + "has today — see a11y.keyboard-focus.",
  },

  // ---- Effects and integrations ------------------------------------------
  {
    id: "effect.bell",
    capability: "Bell dispatches once per occurrence",
    disposition: "implemented",
    proof: {
      by: "lane",
      test: "core/frontend/terminal/tests/terminalOscNotification.test.ts",
    },
  },
  {
    id: "effect.osc9-notification",
    capability: "OSC 9 raises one notification per occurrence",
    disposition: "implemented",
    proof: {
      by: "lane",
      test: "core/frontend/terminal/tests/terminalOscNotification.test.ts",
    },
  },
  {
    id: "effect.exit",
    capability: "Child exit is visible and the tab reflects it",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalSessions.test.ts" },
  },
  {
    id: "effect.clipboard-write",
    capability: "Clipboard effects report a declared outcome rather than "
      + "failing silently when the gesture requirement is unmet",
    disposition: "implemented",
    proof: {
      by: "lane",
      test: "core/frontend/terminal/tests/terminalSemanticSession.test.ts",
    },
    note: "Each OSC 52 clipboard-write effect produces one visible refusal. "
      + "The semantic client does not call a clipboard API or expose the "
      + "requested contents.",
  },
  {
    id: "effect.title",
    capability: "Title and working directory reach the shell chrome",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalSessions.test.ts" },
  },
  {
    id: "links.activation",
    capability: "An OSC 8 hyperlink decorates, hit-tests and activates",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalLinkTargets.test.ts" },
    note: "Three parts, each proved where it lives: the decoration is the "
      + "plan's underline (tests/terminalCellSurface.test.ts), the address is "
      + "paint.hit-test, and the run and the click that opens it are here and "
      + "in tests/terminalPointerRouter.test.ts. What no lane covers is the "
      + "platform opener itself. A link is a link because the host marked it, "
      + "which is the whole difference from links.plain-text below.",
  },
  {
    id: "links.plain-text",
    capability: "A URL written in plain output is a link",
    disposition: "changed",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalLinkTargets.test.ts" },
    owner: "Dariusz Debowczyk, product owner, 2026-08-11",
    decision: "docs/ops/terminal-link-behavior.md",
    note: "Approved removal for the semantic terminal. Only OSC 8 links are "
      + "active. Plain output stays plain because the host did not mark it as "
      + "a link.",
  },

  // ---- History -------------------------------------------------------------
  {
    id: "history.transport",
    capability: "The rows behind the viewport cross the client boundary as the "
      + "host's own rows and are held by the client model",
    disposition: "implemented",
    proof: {
      by: "lane",
      test: "core/frontend/terminal/tests/terminalHistoryWindow.test.ts",
    },
    note: "Open end to end — Tauri command, control frame and CLI — and gated "
      + "by terminalHistoryFixture.json, which the host's own parser writes. "
      + "One window at a time: joining two reads by row number would be a "
      + "client guessing across eviction, which needs anchors nothing carries "
      + "yet.",
  },
  {
    id: "history.window",
    capability: "A history window renders without fabricating rows",
    disposition: "implemented",
    proof: {
      by: "lane",
      test: "core/frontend/terminal/tests/terminalViewportComposition.test.ts",
    },
    note: "A reader who scrolls back is shown host history rows above the live "
      + "screen, composed by terminalViewportComposition.ts and painted by the "
      + "presenter. Every row is a row the host wrote; a view whose rows are "
      + "not held owes a frame rather than showing the bottom instead. The "
      + "wheel moves the reading position "
      + "(tests/terminalPointerRouter.test.ts) and the session reads what it "
      + "displays (tests/terminalSemanticSession.test.ts).",
  },
  {
    id: "history.stable-view",
    capability: "A reader scrolled back stays on the same lines while the "
      + "child keeps writing",
    disposition: "implemented",
    proof: {
      by: "lane",
      test: "core/frontend/terminal/tests/terminalReadingAnchor.test.ts",
    },
    note: "Row numbers are positions and eviction moves them, which no screen "
      + "frame reports: while retention grows, numbers hold and historyRows "
      + "moves; at the retention limit, historyRows holds and every number "
      + "moves. So the reading position is a host anchor now. Leaving the "
      + "bottom pins the row displayed as a line the host tracks, and each "
      + "frame resolves it: a line that moved moves the reader, a line the "
      + "terminal dropped puts them on the oldest row it kept, and a line back "
      + "on the active area returns them to the bottom. The anchor crosses "
      + "every boundary — Tauri commands, the control socket "
      + "(control.rs::an_anchor_follows_its_line_over_the_socket) and the CLI "
      + "— and terminalAnchorFixture.json is the host's own shape. A host that "
      + "refuses to anchor is reported once and reading goes on by row number.",
  },
  {
    id: "history.retention",
    capability: "Retention is the host's policy, not the renderer's",
    disposition: "implemented",
    proof: { by: "lane", test: "core/frontend/terminal/tests/terminalRetention.test.ts" },
  },

  // ---- Measured behaviour ---------------------------------------------------
  {
    id: "measure.sustained-output",
    capability: "Sustained output is measured in the packaged app",
    disposition: "implemented",
    proof: { by: "scenario", id: "measure.sustained-output" },
  },
  {
    id: "measure.hidden-catchup",
    capability: "A hidden tab keeps its model current and repaints on reveal",
    disposition: "implemented",
    proof: { by: "scenario", id: "measure.hidden-catchup" },
    note: "The unit lane proves the control flow. The packaged scenario is the "
      + "required proof that the mounted Tauri path does no hidden screen work "
      + "and resumes from current state after demand returns.",
  },
  {
    id: "measure.attachment-fanout",
    capability: "Multiple semantic attachments share one encoded screen state",
    disposition: "implemented",
    proof: { by: "scenario", id: "measure.attachment-fanout" },
  },
  {
    id: "measure.slow-client-recovery",
    capability: "A slow semantic attachment keeps one frame and resumes at newest state",
    disposition: "implemented",
    proof: { by: "scenario", id: "measure.slow-client-recovery" },
  },

  // ---- Accessibility ---------------------------------------------------------
  {
    id: "a11y.keyboard-focus",
    capability: "The terminal is reachable and escapable by keyboard",
    disposition: "blocking",
    proof: { by: "manual", procedure: "docs/ops/terminal-interaction-review.md" },
    note: "Current product behaviour; the migration cannot silently drop it. "
      + "The semantic surface takes keys in a text area, and that field now "
      + "carries the Tab stop xterm's own helper field carries "
      + "(tabIndex = 0) — parity, not a choice made here. No lane can mount a "
      + "webview to press Tab, so a person confirms the stop and the way back "
      + "out with the packaged interaction procedure.",
  },
  {
    id: "a11y.screen-reader",
    capability: "Screen-reader live-region announcement of terminal output",
    disposition: "absent",
    proof: { by: "none" },
    note: "xterm can support it; the product does not ship it. Included as "
      + "absent so adding it is a decision rather than a side effect.",
  },
  {
    id: "search.buffer",
    capability: "In-terminal text search",
    disposition: "absent",
    proof: { by: "none" },
    note: "Same reasoning as a11y.screen-reader.",
  },
];

/** Dispositions that may carry `{ by: "none" }`. */
export const DISPOSITIONS_WITHOUT_PROOF: ReadonlySet<CapabilityDisposition> = new Set([
  "blocking",
  "absent",
]);

/** Entries that block the area-05 cutover while they remain unproven. */
export function blockingCapabilities(
  register: readonly CapabilityEntry[] = TERMINAL_CAPABILITY_REGISTER,
): readonly CapabilityEntry[] {
  return register.filter((entry) => entry.disposition === "blocking");
}

/** Scenario ids the register expects to exist. */
export function requiredScenarioIds(
  register: readonly CapabilityEntry[] = TERMINAL_CAPABILITY_REGISTER,
): ReadonlySet<ScenarioId> {
  const ids = new Set<ScenarioId>();
  for (const entry of register) {
    if (entry.proof.by === "scenario") ids.add(entry.proof.id);
  }
  return ids;
}
