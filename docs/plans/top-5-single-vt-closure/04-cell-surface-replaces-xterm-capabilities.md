# The cell surface replaces every xterm capability

## Outcome

A presentation-only terminal surface renders the client cell model and handles
gestures, input capture, and platform integration. It parses nothing. Every
capability Shipctl gets from xterm today is either supplied by the host, rebuilt
at the surface, or recorded as an accepted loss with a named approver. No
capability is lost by discovery.

## Context and purpose

This is the largest change in the plan and the one most likely to be
underestimated, because most of what xterm does for Shipctl is invisible in
Shipctl's source. We call a small API — `options` 19 times, `rows` 6,
`scrollToBottom` 5, `loadAddon` 5, `cols` 4, `buffer` 4, `scrollToLine` 3,
`refresh` 3, `element` 3, `resize` 2, `open` 2, `dispose` 2, and one each of
`write`, `reset`, `unicode`, `parser`, `onData`, `onBell`, `focus`, and
`attachCustomKeyEventHandler`. We inherit far more without calling anything.

The installed source splits along exactly the boundary this plan draws.
`@xterm/xterm 6.0.0` is 13,081 lines of `src/common/` — parser, buffer, reflow,
terminal semantics — which Ghostty already replaces, and 8,490 lines of
`src/browser/` — presentation, input, selection, links, accessibility — which
this change owns. `@xterm/addon-webgl 0.19.0` adds 4,621 lines of accelerated
rendering. Those numbers are evidence of scale, not a budget, and not an
estimate of our work: we need less than all of it, because we call no
decoration API, and more than a straight port, because the surface must consume
a host cell model rather than a local buffer.

Two constraints are easy to miss and expensive to discover late.

**Transparency is a behavior requirement.**
`core/frontend/terminal/terminalRenderer.ts` defines
`GLASS_PREFERENCE = ["dom"]` and `OPAQUE_PREFERENCE = ["webgl", "dom"]` because
glass themes composite over the app gradient and the native window effect, and
WebGL paints an opaque rectangle. That is how Shipctl solves it today, with two
render paths selected by theme and per-terminal failure fallback including
`onContextLoss`. The requirement this change inherits is the behavior —
transparent visual correctness, sustained-output performance, and recovery from
render failure — not the two-path implementation. The smallest implementation
that proves all three outcomes is the right one.

Recovery from render failure is local. Because the client cell model is
renderer-independent, a lost drawing context, a failed accelerated path, or a
recreated surface repaints from the model that is already correct. It does not
ask the host for a snapshot, and it is not one of the four recovery boundaries
in [change 03](03-attachment-model-is-renderer-independent.md).

**Cell metrics are currently borrowed.** `terminalMeasure.ts:29-42` constructs a
hidden `Terminal`, loads `FitAddon`, calls `proposeDimensions()`, and disposes
it, purely to convert container pixels into columns and rows. Metrics must be
owned before the first cell is painted, or every later measurement is taken
against a borrowed one.

## Dependencies

- [Change 01](01-ghostty-semantic-contract-and-retention-are-proven.md) has
  proven the semantic and retention contracts, including the OSC 9 notification
  body, the selection gesture API, and the input-mapping seams, and its stop
  gates have passed.
- [Change 02](02-semantic-frame-transport-is-versioned-and-measured.md) delivers
  frames at a measured cost for realistic batching.
- [Change 03](03-attachment-model-is-renderer-independent.md) provides the
  client cell model, viewport intent, and history windows.

## The parity inventory

This is the contract. Every item is either **host**, **surface**, or **accepted
loss**, and nothing may be unclassified at exit.

### Host supplies it — the surface consumes, never derives

Verified as public API in the pinned `libghostty-vt`
(`core/backend/Cargo.toml:23`):

1. cell content, styles, colors, graphemes, wide cells (`render.rs`,
   `screen.rs`);
2. hyperlink URIs per cell, wrap and wrap-continuation state, semantic prompt
   marks (`screen.rs`);
3. cursor position, visibility, style, blink, password mode, and wide-tail
   position (`render.rs`);
4. palette, colors, modes, active screen, viewport, scrollbar (`render.rs`,
   `terminal.rs`);
5. key encoding with kitty flags, `modify_other_keys` state 2, cursor and keypad
   application modes, alt-esc prefix, and macOS option-as-alt (`key.rs`);
6. mouse encoding with tracking mode, format, size, and button state
   (`mouse.rs`);
7. bracketed paste encoding and paste safety (`paste.rs`);
8. the selection model *and its semantics*: ranges, ordering, adjustment,
   containment, per-cell `is_selected()`, and `select_word`, `select_line` with
   a semantic-prompt boundary option, `select_output`, `select_word_between`,
   and `select_all`, plus copy formatting through `format_selection_alloc` and
   `format_selection_buf` with unwrap and trim options (`selection.rs`,
   `render.rs`).

The consequence worth stating: selection *logic* is host-side, including word,
line, and output behavior and the text that copy produces. The surface owns
pixel-to-cell hit testing, pointer capture, edge and autoscroll timing, paint,
and clipboard permissions, and sends cell-coordinate gesture events to the host.

The gesture machine is host-side too, and it has a safe wrapper. At the pinned
revision, `crates/libghostty-vt/src/selection.rs:28` declares `pub mod gesture`,
and `crates/libghostty-vt/src/selection/gesture.rs` exposes `Gesture`,
`PressEvent`, `ReleaseEvent`, `DragEvent`, `AutoscrollTickEvent`,
`DeepPressEvent`, `Autoscroll`, `Behavior`, and `Behaviors`, with click count,
dragged state, anchor, event time and repeat interval, repeat distance,
rectangle mode, word-boundary codepoints, and single, double, and triple click
behaviors. So click counting is host-owned. The surface supplies pointer
position, timing, and modifiers, and does not keep a second counter. Change 01
still exercises this API; it does not have to build it.

### The surface must build it

Each item below is behavior Shipctl receives today without calling any API, so
it has no existing code to migrate.

1. **Glyph painting** — glyph atlas or equivalent, draw batching, and recovery
   from render failure, meeting the transparency and throughput outcomes above.
2. **Font metrics and cell sizing** — owned, replacing `terminalMeasure.ts`.
3. **Pixel-to-cell hit testing** — the input to every gesture, hover, and mouse
   report coordinate. The host has no pixels and cannot supply this.
4. **Selection interaction** — pointer capture, drag tracking, edge autoscroll
   timing, and selection paint, driving the host gesture and selection API
   rather than reimplementing click counting or word and line semantics.
5. **Clipboard copy and paste**, including platform permission behavior. The
   copied text comes from the host formatter.
6. **IME composition capture**, including the committed-text path and its
   interaction with the host key encoder. A Latin-keyboard test pass never
   reaches this; it needs its own fixtures and a manual pass.
7. **Link affordance** — hover detection, underline, and hit region, for OSC 8
   hyperlinks *and* plain-text URLs, which the current `WebLinksAddon` also
   detects. The click action already belongs to us
   (`TerminalView.tsx:103-105` hands the URL to `openUrl`).
8. **Scroll surface** — scrollbar, wheel and key scrolling, and scroll paint,
   driven by the viewport intent and history windows change 03 owns.
9. **Focus, blur, and cursor blink paint.**
10. **Glyph placement that agrees with host-supplied widths.** Unicode width
    remains host-canonical. The painter needs metrics and grapheme placement
    consistent with the widths it receives, and must not introduce a second
    width authority.
11. **Custom keybinding precedence.** `TerminalView.tsx:139-160` matches enabled
    presets and writes `preset.sequence`, suppressing xterm's handling. These
    are application commands, not keyboard encoding. The precedence must hold
    ahead of terminal input dispatch, and the sequence must still travel through
    the host as an explicit literal-sequence operation. The frontend does not
    regain a general raw PTY write path.

### Accessibility — preserve the real baseline, and do not overclaim

xterm's screen-reader model is **not** part of Shipctl's current behavior.
`screenReaderMode` defaults to `false`
(`node_modules/@xterm/xterm/src/common/services/OptionsService.ts:38`),
`AccessibilityManager` is constructed only when it is true
(`browser/CoreBrowserTerminal.ts:554`), and Shipctl never sets the option.

What Shipctl does inherit, and what this change must preserve, is the focusable
hidden textarea, its prompt `aria-label`, keyboard input, and IME behavior. A
live region and screen-reader output model is a separate product enhancement.
It is neither a closure gate here nor an accepted loss, and the distinction is
recorded so nobody later claims parity the product never provided.

## Work to be done

1. Complete the inventory above against the code at implementation time, not
   against this document. Any capability found unclassified stops the change
   until it is classified.
2. Build metrics and hit testing first, and prove them against the current
   `FitAddon`-derived geometry for a corpus of fonts, sizes, and line heights.
3. Build the painting path against all three outcomes together — transparent
   correctness, sustained-output performance, and recovery from render failure.
   None may be deferred to a later milestone, whatever implementation is chosen.
4. Render the client cell model directly: styled graphemes, wide cells and
   combining marks, cursor styles, selection paint, and link underline. The
   surface never holds a second copy of terminal state.
5. Route every input through a semantic command to the host encoders. Keep
   custom keybinding precedence ahead of terminal dispatch, expressed as an
   explicit literal-sequence operation through the host. Prove that no browser
   event path produces duplicate text or lost modifiers, especially through
   composition.
6. Drive the host selection gesture and selection API from pointer events, and
   copy the host-formatted text through the platform clipboard. Prove selected
   text matches host cell content for wide cells, graphemes, wrapped logical
   lines, and rectangular selection.
7. Implement link affordance for OSC 8 and plain text, and keep the existing
   `openUrl` action.
8. Implement the scroll surface against viewport intent and history windows, and
   state the in-flight behavior for a window that has not arrived.
9. Preserve the accessibility baseline: focusable input target, prompt label,
   keyboard input, and IME. Do not claim screen-reader parity, and do not remove
   the baseline as a side effect of replacing the renderer.
10. Build a characterization corpus that runs against xterm *and* the new
    surface during migration, so parity is measured rather than asserted. xterm
    is a temporary oracle here and never a standing authority.
11. Measure sustained-output throughput, frame time under continuous scroll,
    memory per terminal, and scroll latency for a history window that misses the
    cache. Compare against the recorded pre-change baselines.
12. Perform a manual macOS pass with the packaged application covering IME
    composition in a non-Latin input method, selection and copy, link click,
    transparent and opaque themes, renderer failure fallback, full-screen
    programs, and long history.

## Acceptance criteria

- Every inventory item is classified host, surface, or accepted loss. No item is
  unclassified, and every accepted loss has a named approver in the register.
- The surface parses no PTY bytes and no ANSI. It contains no VT state machine
  and no terminal buffer. This is proved by absence from the diff and by the
  import graph.
- The frontend has no general raw PTY write path. Every byte reaching the PTY
  is produced by a host encoder or by an explicit literal-sequence operation.
- A transparent theme composites over the app background with no opaque
  rectangle, sustained-output performance meets the recorded constraint, and a
  render failure degrades to a working surface rather than a blank one.
- Owned metrics reproduce the current `FitAddon`-derived geometry across the
  font corpus, or the difference is measured and accepted by a named owner.
- Selected text matches host cell content for wide cells, graphemes, wrapped
  logical lines, and rectangular selection, and word, line, and output selection
  behavior comes from the host.
- Copy and paste work through the platform clipboard, and bracketed paste is
  encoded by the host.
- IME composition in a non-Latin input method produces the same PTY bytes as the
  current implementation, with no duplicated or dropped text, verified by
  fixtures and by the manual pass.
- Custom keybindings take precedence over terminal input dispatch, unchanged
  from today's behavior.
- OSC 8 hyperlinks and plain-text URLs are detected, indicated on hover, and
  opened through the existing action.
- Glyph placement agrees with host-supplied widths across the Unicode corpus,
  and no width table in the frontend can contradict the host.
- The accessibility baseline — focusable input target, prompt label, keyboard
  input, IME — is preserved, and no document claims screen-reader parity.
- The parity corpus passes against the new surface. Where it diverges from
  xterm, each divergence is recorded with its reason and approver.
- Sustained-output throughput, frame time, memory per terminal, and
  cache-missing scroll latency are measured and recorded, and regressions are
  fixed or accepted by a named owner.
- The packaged-application manual pass covers every item in the list above.

## How to validate

```sh
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalCellSurface.test.ts \
  core/frontend/terminal/tests/terminalMetrics.test.ts \
  core/frontend/terminal/tests/terminalSelection.test.ts \
  core/frontend/terminal/tests/terminalInput.test.ts
rg -n "@xterm" core/frontend/terminal
just test parity-corpus
just test fast
just check all
git diff --check
```

During migration the `@xterm` search is expected to return the oracle harness
and the surviving legacy path only. Any hit in the new surface is the parity
claim failing. [Change 05](05-single-vt-cutover-removes-parser-duplication.md)
requires the same search to return nothing outside the deleted path.

Rendering correctness is asserted against the cell model, not against a
screenshot: for a given model state, the surface must report the same glyph,
style, width, cursor, and selection facts the model holds. Screenshot
comparison, if used, supplements that and does not replace it.

## Exit and rollback

Exit when the inventory is fully classified, the painting path passes all three
outcome gates, the parity corpus is green, and the measurements are recorded.
If a capability cannot be rebuilt at acceptable cost, record it as an accepted
loss with an approver or stop the cutover — do not ship a surface that silently
drops it, and do not reintroduce a frontend parser to recover it.
