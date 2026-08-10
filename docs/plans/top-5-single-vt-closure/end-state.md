# Terminal single-VT closure end state

## Executive decision

Shipctl will have one VT authority: `libghostty-vt` inside the backend terminal
runtime. The frontend will receive versioned semantic screen state and ordered
terminal effects, maintain a renderer-independent client model, and paint cells
without parsing PTY bytes or ANSI.

The independent critique is correct about the root cause. A permanent
Ghostty-plus-xterm design still has two emulators that can disagree about
geometry, reflow, palette, cursor, and history. Ordered resize and palette
barriers reduce the opportunity for disagreement, but do not remove it. The
previous controlled-dual-parser plan is therefore superseded, not extended.

During migration, the old xterm path may remain behind one switch as a
comparison oracle and production rollback. It receives no new capability and
is deleted at cutover. It is not an alternative end state.

```text
PTY bytes
  -> TerminalRuntime actor
       libghostty-vt: the only parser and terminal-state authority
  -> versioned semantic stream
       screen snapshots/deltas + history windows + ordered effects
  -> TerminalAttachmentController
       generation/order/recovery + canonical client cell model
  -> TerminalSurface
       pixels, hit testing, input capture, gestures, viewport intent
```

Input travels in the opposite direction as semantic key, text, paste, mouse,
selection-gesture, resize, and application-command messages. The host orders
them with PTY output and uses Ghostty's mode-aware encoders before writing the
PTY. No general frontend raw-byte path survives.

## Root cause being closed

Today Ghostty parses PTY output in Rust, while xterm parses the same output in
the webview. Recovery makes the split explicit: Ghostty formats its state back
to ANSI, `TerminalView` resets xterm, and xterm parses the reconstructed bytes.
Routine resize, theme, and visibility behavior has consequently become
terminal reconstruction and reconciliation logic.

This creates three inseparable failure modes:

- two parsers can apply adjacent bytes at different geometry or mode state;
- terminal meaning is split between host state and undocumented behavior
  inherited from xterm; and
- reset plus ANSI replay is used to force convergence even though it cannot
  prove the two implementations now hold identical state.

The retention defect compounds the symptoms but is not the architectural root
cause. Ghostty's `max_scrollback` is a byte heuristic, despite the pinned Rust
binding documenting it as lines. Shipctl passes `1_000`, which is normally
below Ghostty's geometry-derived minimum and therefore does not select the
effective cap. The user's row setting is not connected to the host at all.

## Current versus target

| Concern | Current | Target |
| --- | --- | --- |
| VT parsing | Ghostty in host and xterm in view | Ghostty in host only |
| Frontend stream | PTY bytes and replay ANSI | semantic state and effects |
| Recovery | reset, then reparse ANSI | atomic semantic snapshot |
| Resize | two reflows, repaired by replay | one host resize |
| Palette | app theme and OSC can diverge | host facts, surface paint |
| History | separate host and xterm stores | host windows by revision |
| Input | browser VT mode participates | semantic event, host encoder |
| Selection | xterm interaction semantics | browser pixels, host semantics |
| Hidden tabs | visibility ends attachment | model stays current; no paint |
| Renderer | xterm DOM/WebGL and addons | non-emulating cell surface |

## Normative authority contract

### Backend terminal actor and Ghostty

The host owns the PTY, parse order, screen and alternate-screen state, geometry,
cursor, modes, semantic colors and palette, graphemes and widths, hyperlinks,
wrap state, retained history, selection semantics, input encoding, lifecycle,
terminal identity, stream sequence, and state revision. All terminal mutations
are serialized by the runtime actor.

The host also emits ordered side effects that must not be inferred from cells:
bell, title, working directory, desktop notification, clipboard request, and
other supported Ghostty effects. The pinned binding's missing OSC 9 payload is
a contract gap to close, not permission for the browser to parse OSC.

### Attachment controller and client model

The DOM-free frontend controller owns attachment generation, protocol decode
and validation, expected sequence, base-revision validation, atomic snapshot
installation, delta application, recovery coalescing, history-window request
state, and the canonical client cell model. It exposes facts to a surface; it
does not interpret terminal escape sequences.

### Presentation surface

The surface owns font measurement, proposed cell geometry, glyph painting,
cursor and selection paint, pixel-to-cell hit testing, pointer capture,
focusable input and IME capture, clipboard permissions, link affordance and URL
activation, scroll controls, viewport intent, and visibility-aware paint
scheduling. It does not decide Unicode cell width, word or line selection,
terminal modes, colors, or any other VT fact.

This boundary deliberately distinguishes interaction from terminal meaning.
For example, the browser converts a pointer location to a cell and delivers a
gesture event; Ghostty determines word, line, anchor, autoscroll, range, and
copied text; the browser paints the returned selection.

## Semantic stream contract

The durable protocol has one versioned envelope and exhaustive adapters for
Tauri, the control socket, CLI consumers, and TypeScript. Every state-bearing
frame identifies the terminal, stream sequence, state revision, and any base
revision it depends on.

It carries three distinct forms of information:

1. **Screen state** — complete semantic snapshots and deltas containing
   geometry, cells/runs, graphemes, style and color references, wrap and wide
   cell facts, cursor, active screen, and renderer-relevant state.
2. **History windows** — host-retained rows requested by stable viewport
   anchors, with the source revision and explicit eviction or stale-anchor
   outcomes. Retention does not make every live snapshot scale with all
   history.
3. **Effects and lifecycle** — ordered, non-cell facts such as bell, title,
   notification, clipboard, exit, and closure. Lossy coalescing is permitted
   only for state whose contract explicitly allows it; effects are not
   silently coalesced.

Ghostty dirty state is an input to the delta encoder, not the wire contract.
Shipctl owns baseline revisions, invalidation, subscriber state, validation,
and recovery.

## Geometry, theme, visibility, and recovery

Resize is a host mutation. The browser proposes rows and columns from owned
font metrics; the runtime orders the resize with PTY output, changes Ghostty
once, and emits the resulting geometry and semantic screen state. A geometry
change may require a full semantic frame, but never ANSI replay or a second
reflow authority.

Application themes supply defaults and presentation decoration. Child-owned
OSC palette/default-color state is not overwritten. The surface paints the
semantic colors emitted by the host and may apply non-terminal decoration such
as transparency without changing terminal meaning.

Visibility is presentation only. Once attached, a hidden terminal continues
to consume and validate the semantic stream while suppressing avoidable paint.
Showing it schedules paint from the current client model; it does not detach,
reparse, or create a routine recovery.

Recovery is permitted when a baseline cannot be trusted:

1. initial attachment;
2. deliberate client-cell-model recreation or loss;
3. sequence or base-revision mismatch; or
4. subscriber/attachment queue overflow.

A recovery snapshot captured at boundary `N` is installed atomically. Frames
at or before its boundary are discarded, later frames wait, and delta delivery
resumes from the declared next sequence and revision. Resize, theme, focus,
normal hide/show, and ordinary descriptor changes are not recovery causes.

No process-incarnation field is added under the current product contract.
Terminal IDs are non-reused runtime UUIDs, and backend restart destroys the
runtime rather than reconnecting an old ID. If terminal survival across host
restarts becomes a feature, it must add an explicit runtime identity before
reuse is possible.

## Capability parity at cutover

Removing xterm removes behavior Shipctl receives without explicit call sites.
Cutover therefore requires proof for the current product surface, including:

- styled graphemes, combining characters, wide cells, wrap boundaries,
  cursor forms, semantic colors, transparency, and alternate screen;
- font measurement, geometry proposal, sustained-output rendering, and
  rendering-failure recovery;
- focus, keyboard input, custom keybinding commands, paste safety, mouse
  reporting, IME composition, and the current focusable labelled-input
  accessibility baseline;
- selection gestures, selection paint, copy, paste, viewport scrolling,
  retained-history windows, and hidden-tab behavior;
- OSC 8 hyperlinks, plain-text URL detection, hover/click affordance, and safe
  external URL activation; and
- bell, title, working directory, OSC notifications, clipboard requests,
  lifecycle, exit, and error behavior.

Shipctl does not enable xterm's `screenReaderMode`; its live-region
`AccessibilityManager` is therefore not current parity. A new screen-reader
output model is valuable product work, but is outside essential closure unless
the owner adds it explicitly. Search is also not a cutover claim unless a
current integration or approved requirement is identified; no search addon is
installed today.

Neither WebGL nor two presentation implementations is mandated. The chosen
surface must prove the observable transparent and opaque behavior, performance,
and failure fallback that the supported product requires. The implementation
follows that evidence.

## Path and five change areas

Implement the following in dependency order:

1. [Ghostty semantic contract and retention are proven](01-ghostty-semantic-contract-and-retention-are-proven.md).
2. [Semantic frame transport is versioned and measured](02-semantic-frame-transport-is-versioned-and-measured.md).
3. [Attachment and client model are renderer-independent](03-attachment-model-is-renderer-independent.md).
4. [A presentation-only cell surface replaces xterm behavior](04-cell-surface-replaces-xterm-capabilities.md).
5. [Single-VT cutover removes parser duplication](05-single-vt-cutover-removes-parser-duplication.md).

Area 1 is an executable falsification spike. It proves the dependency can be
the sole authority, exposes gaps, and closes the retention contract before the
expensive surface work starts. If it falsifies the destination, implementation
halts and returns measured evidence for an owner decision; it does not silently
make dual parsing permanent.

The preparatory plan remains useful for the DOM-free test seam, service-owned
retention, dependency ownership, and single-writer state. Its raw-PTY Tauri
output cutover is superseded: optimizing bytes sent to a parser being removed
is dead work. The exhaustive protocol-mapping principle survives and is
implemented for semantic frames in area 2.

## Decision register

Open rows block area 4 and final cutover. A row closes only with evidence, the
selected contract, date, and a named approver.

| Decision | Owner | Required evidence | State |
| --- | --- | --- | --- |
| Retention promise | product | area 1 measurements | closed |
| Running retention updates | product | area 1 API and UX evidence | closed |
| Ghostty dependency branch | engineering | area 1 gaps and fixture | closed |

All three closed on 2026-08-10, approver Dariusz Debowczyk:

- **Retention promise:** a byte budget backed by the measurements in
  `core/backend/src/terminal/retention.rs`. No row promise anywhere in the
  product.
- **Running retention updates:** construction-only. The pinned API has no
  retention setter.
- **Ghostty dependency branch:** pinned upstream, no vendoring. The OSC 9
  payload goes upstream first.

The selected contracts and their evidence are in
`docs/ops/terminal-vt-dependency.md`, the durable page for all three.

The retention choice is either exact configured row retention backed by an
owned row-trim capability, or an honestly stated byte-retention contract backed
by measurements. A row setting must never be passed to a byte heuristic by
name or implication.

The pinned API accepts the retention limit only when constructing a terminal.
The running-update choice is therefore either a setting explicitly documented
as applying to newly created terminals, or an owned dependency extension that
changes a live limit without destroying retained history. Reconstructing the
terminal to apply a setting is not an admissible branch.

## Completion contract

This architecture is complete only when all of the following are proven:

- PTY output is parsed exactly once, in the backend Ghostty runtime.
- The webview receives no raw PTY output and parses no ANSI or OSC.
- Semantic snapshots, deltas, history windows, effects, and input commands are
  versioned, validated, ordered, and covered by cross-language fixtures.
- Resize, palette, visibility, history, selection, input, lifecycle, and
  recovery each have the single authority declared above.
- The current-product capability inventory passes against the new surface in a
  packaged desktop build, including IME and transparent themes.
- The xterm migration switch, packages, addons, ANSI formatter replay, raw
  frontend output types, and duplicate parser path are deleted.
- The retention and dependency decision rows are closed with named approvers.

## Validation

Each area owns focused tests and evidence. The final proof includes host unit
and property tests, Rust-to-TypeScript wire fixtures, DOM-free controller trace
tests, browser interaction and visual tests, recorded runtime measurements, and
packaged macOS exercises under live output.

Repository-wide gates remain:

```sh
just check all
just test fast
just test rust
just test full
just modularity boundaries
markdownlint docs/plans/top-5-single-vt-closure/*.md
git diff --check
```

The previous controlled-dual-parser decision remains available as evidence in
[`top-5-closure`](../top-5-closure/README.md). It is not a second canonical
implementation plan.
