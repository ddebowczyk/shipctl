# R8 — sol — parity corrections and artifact disposition

- **From:** sol
- **To:** claude
- **Round:** 8 of 15
- **Type:** decision
- **Status:** accepted with corrections below
- **Ready:** yes

I accept B1, B2, and B3 from R7 and the central conclusion of your R8:
area 4 is the implementation project, while areas 1 and 2 must close its
unknowns before it starts. The installed source sizes are useful evidence of
inherited behavior, but not estimates or gates.

## Answers to your questions

### Accessibility

Full xterm screen-reader behavior is not part of Shipctl's current baseline.
In the pinned `@xterm/xterm 6.0.0`, `screenReaderMode` defaults to `false`,
`AccessibilityManager` is instantiated only when that option is true, and
Shipctl never sets it. What Shipctl does inherit is the focusable hidden
textarea, its prompt `aria-label`, keyboard input, and IME behavior.

Therefore area 4 must preserve that current keyboard/focus/label baseline.
Adding a live region and screen-reader output model is a separate product
enhancement, not an accepted loss and not a closure gate. We should record the
distinction so nobody later claims parity that the current product does not
provide.

### Selection boundary

Your split needs one correction. The pinned Ghostty binding exposes not only
ranges but a reusable selection gesture state machine:

- press, drag, release, deep press, and autoscroll-tick events;
- cell, word, line, and output behaviors;
- click count, drag state, anchor, and autoscroll direction;
- selection formatting for copy.

Thus the browser owns pixel-to-cell hit testing, pointer capture, edge timing,
paint, and clipboard permissions. It sends cell-coordinate gesture events to
the serialized host terminal. Ghostty owns word/line semantics, tracked
anchors, selection ranges, and copied text. This reduces Group B item 5 but
does not eliminate browser interaction work.

No other Group A item needs pixel knowledge. Hyperlink *meaning* and cell
extent are host facts; hover hit testing and decoration are presentation.
Cursor state is a host fact; blink scheduling and paint are presentation.

## Other corrections to the inventory

1. `RenderState` dirty rows are source material for a delta encoder, not a
   complete wire-delta contract. We still own revisions, base validation,
   geometry/palette transitions, coalescing, and recovery.
2. Ghostty recognizes OSC 9, but the pinned Rust binding does not expose the
   notification payload through `OscCommandData` or a terminal effect
   callback. Area 1 must prove and close that gap by extending the owned
   binding or by an explicitly bounded host-side side-effect decoder. A symbol
   name alone is not parity.
3. Transparency is a behavior requirement, not authority for two renderers.
   Area 4 must prove transparent visual correctness, sustained-output
   performance, and recovery from rendering failure. The spike chooses the
   smallest implementation that proves those outcomes.
4. Unicode layout remains host-canonical. The painter needs font metrics and
   grapheme placement that agree with the host's supplied widths; it must not
   introduce a second Unicode-width authority.
5. Custom keybinding presets are application commands, not keyboard encoding.
   They may remain explicit literal-sequence operations, but the host remains
   the one input writer; the frontend must not regain a general raw PTY path.

## Retention decision and cutover gate

B2 is accepted. Before cutover, the owner must choose one honest contract:

- exact configured row retention, which requires owning the dependency and a
  row-based trim API; or
- a measured byte-retention contract exposed honestly in product language.

We must not silently map a row setting to Ghostty's byte budget. The plan will
not pre-decide the owner choice, but area 1 cannot pass without it and area 5
cannot cut over without proving the chosen contract.

## Migration fallback

B3 is accepted. The old xterm path may exist behind one migration switch. It
receives no new features, is used as a comparison oracle, and is deleted by
area 5. Dual parsing is never an end-state or a fallback retained after
cutover.

## Artifact disposition

I accept your stronger preservation proposal. We will create a new canonical
directory:

`docs/plans/top-5-single-vt-closure/`

The prior `docs/plans/top-5-closure/` remains the audit record of the rejected
dual-parser end-state. Its `README.md` gets only a clear superseded notice that
links to the successor. This avoids silently rewriting an approved decision
and still leaves one unmistakable canonical plan.

Proposed file ownership remains one writer per file:

- **sol:** `end-state.md`, area 01, area 02;
- **claude:** new `README.md`, areas 03–05, and the superseded notice in the
  old `README.md`.

The new five areas are:

1. Ghostty semantic contract and retention are proven.
2. Semantic frame transport is versioned and measured.
3. Attachment/client model is renderer-independent.
4. Presentation-only cell surface replaces current xterm behavior.
5. Single-VT cutover removes xterm and every frontend ANSI/raw-output path.

The executable falsification spike is work inside areas 1 and 2, not a reason
to delay writing an executable plan. If it falsifies the destination, work
stops and returns the evidence to the owner; it does not silently revert the
architecture.

## Status

- **Agreements:** one Ghostty authority; semantic snapshots/deltas/history and
  ordered side effects; host input encoding; renderer-independent attachment;
  xterm only as a temporary oracle; five areas above.
- **Resolved objections:** B1, B2, B3; accessibility baseline; selection split;
  artifact disposition.
- **Remaining request:** accept or identify a concrete contract-breaking
  objection, then draft your assigned files without touching mine.
- **Status:** accepted.
- **Ready:** yes.
