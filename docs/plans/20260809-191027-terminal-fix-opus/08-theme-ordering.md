# Phase 08 — Theme decoupling and ordered palette changes

## Objective

Stop replaying on theme change. Deliver palette changes as ordered events on
the terminal stream.

Making the remaining replay bounded and history-complete is **phase 09**. The
two were originally one phase; they are separated because they touch
different code (`runtime.rs::set_theme` and the renderer queue, versus the
replay formatter and its selection), rest on different hypotheses, and roll
back independently. Only one thing links them — dropping `.with_palette(true)`
— and that task lives here, where the theme contract is decided.

## Context

`core/backend/src/terminal/runtime.rs:706-716` — a theme change publishes a
full replay:

```rust
fn set_theme(&mut self, theme: &TerminalColorTheme) -> Result<(), String> {
    let response = self.vt.set_theme(theme)?;
    if !response.is_empty() { self.write_response(&response)?; }
    let descriptor = self.record.note_replay_change();
    self.publish_descriptor(descriptor);
    let replay = self.replay().map_err(|error| error.to_string())?;
    let sequence = self.next_sequence();
    self.publish(TerminalEvent::Replay { sequence, replay });
    Ok(())
}
```

The coupling exists because `format_active_screen` (`replay.rs:222`) builds
`FormatterOptions` with `.with_palette(true)`, so the replay *carries* the
palette — which makes a theme change look like it needs one.

Measured: roughly **96%** of a baseline replay is the 256 OSC 4 palette
sequences. Removing them shrinks the replay by more than an order of magnitude
and severs the theme coupling at the same time.

## Reference behaviour

openmux does not replay on theme change at all. It writes a short OSC string
into the parser — `\x1b]10;fg`, `\x1b]11;bg`, `\x1b]12;cursor`, and
`\x1b]4;i;#rrggbb` for palette 0–15 (`color-utils.ts:4-16`) — forces one grid
re-read, and **recolors already-rendered history in JS** through an
old-RGB → new-RGB translation table (`color-utils.ts:27-65`). Nothing is asked
of the child process.

cmux takes the opposite view for one specific case: a `SetDefaults` change
forces `ResyncRequired` for smart renderers because "default changes have no
raw VT representation". It also ships a theme-portable replay variant,
`vt_replay_bounded_theme_portable`, which "omits terminal palette/default-color
OSC state", alongside `vt_replay_bounded(max_bytes)` which "preserves full
history when it fits", shrinks to the active screen when it does not, and
falls back to a reset.

shipctl is better placed than either: xterm.js accepts a theme object
directly, so the renderer can repaint without any replay and without any
translation table.

## Two constraints on "apply it locally" (adopted from the parallel review)

**A local theme apply is not order-free.** Palette state also arrives as
ordinary PTY output — a program can issue OSC 4 or OSC 10/11 at any time. If
the renderer applies a user theme directly while earlier bytes are still
draining inside xterm's asynchronous write queue, the two palette mutations
land out of order. The theme must therefore travel as a **sequenced
`PaletteChanged` marker on the same ordered stream as output**, and be applied
as a queue barrier: earlier `term.write` callbacks drain, the palette changes,
later output is released. This is the same barrier phase 07 introduces for
geometry; build one mechanism and use it twice.

**Applying a theme to a hidden terminal is a known hazard in this repo.**
`core/frontend/terminal/terminalTheme.ts:84-86`:

```ts
// Skip hidden terminals entirely — setting options.theme on a
// terminal with display:none corrupts xterm's internal scroll state.
// Hidden terminals get the theme applied when they become visible
```

`TerminalView.tsx:293,304-305` carries the matching catch-up path on reveal.
Phase 06 keeps hidden terminals *attached*, so after that change a theme
marker can reach a hidden terminal for the first time. The marker must not be
skipped (that would break stream order) and must not be applied blind. Pause
the renderer queue at the palette barrier until reveal, buffering later frames
within the existing 1 MiB bound; on overflow, take the single recovery phase
06 already defines.

**Price that pause before accepting it.** A theme change reaches *every*
terminal at once, so the pause stalls every hidden tab's write queue until
that tab is revealed, and any hidden tab with sustained output crosses the
1 MiB bound and recovers. One theme change can therefore become N recoveries.
That may be acceptable — a recovery is cheap after phase 09 bounds it — but it
is a systemic consequence, not an edge case, and it must be measured and
bounded rather than discovered. Prefer, in order: (a) H8.5 shows the hazard no
longer exists on the pinned xterm and no pause is needed; (b) hidden
application is made safe so the barrier never stalls; (c) the pause ships with
a stated bound on recoveries per theme change.

**Only the palette is ordered. The renderer mode is not.**
`applyThemeToTerminals` (`terminalTheme.ts:81-100`) does two unrelated things
in one loop: it sets `options.theme` — palette state, genuinely ordered against
child-authored OSC bytes — and it swaps the **WebGL addon** according to the
theme's opacity, which has no stream semantics at all. Only the first belongs
in `PaletteChanged`. Renderer mode and transparency stay a presentation
concern, applied by the surface effect, and must not enter the backend domain
type or cross IPC: the host has no business selecting a renderer, and a marker
delivered per-attachment would never reach an xterm without a live attachment.

**Rapid theme changes need a monotonic revision.** Two in-flight theme
requests must not let the older one write last and roll B back to A. Carry a
frontend-monotonic revision in the marker and have the service ignore a stale
one.

## Hypotheses to verify

**H8.1 — the palette is ~96% of the replay, and dropping it does not change
rendered output when the renderer sets the theme locally.**
Method: build a replay with and without `.with_palette(true)` over the same
fixture; compare byte counts, then compare rendered rows after applying the
theme through xterm's own theme option.
Falsifier: rendered output differs — e.g. content that set palette entries
itself via OSC 4 loses them. That is the real question this hypothesis exists
to answer.

**H8.2 — program-set palette state must still survive, and it is two kinds of
state, not one.**
A program can change palette entries at runtime; those are terminal state, not
user theme. Provenance has to be tracked per slot and across *both* families,
because they behave differently under a later theme change:

- **indexed entries** (OSC 4) — the child overrides a specific palette slot;
- **defaults** (OSC 10 foreground, 11 background, 12 cursor) — the child
  overrides what the theme otherwise owns outright.

A blanket `.with_palette(false)` drops both. A blanket keep freezes the old
app theme into terminal content. Method: one fixture per family — stream
issues OSC 4, then OSC 10/11/12 — then attach, change theme, and compare
semantic colours slot by slot.
Falsifier: dropping `.with_palette(true)` also drops program-set entries. Then
the replay must carry *diverged* entries only — the slots differing from the
user theme, in both families — rather than all 256 or none. Total replay byte
size is not evidence here: a decision that reads only the size cannot tell the
two families apart.

**H8.3 — a theme change needs no host round-trip at all.**
Method: apply the theme to xterm locally on the renderer; assert the host VT's
`ColorScheme` still needs updating (it does — `replay.rs` installs an
`on_color_scheme` responder so programs querying colors get correct answers),
but that no replay is required for the renderer to be correct.
Falsifier: some renderer state genuinely cannot be reconstructed without a
replay, in which case adopt cmux's answer and emit `resync_required` for that
case only.

**H8.5 — a hidden terminal cannot safely take a palette change.**
Method: reproduce the `terminalTheme.ts:84-86` claim against the pinned xterm
with a numbered, scrolled buffer under `display: none`.
Falsifier: hidden and visible theme application produce identical buffer and
viewport state — the existing skip is then obsolete and the barrier need not
pause.

## Tasks

1. Land the H8.1/H8.2 fixture comparisons before changing the formatter.
2. Renderer: apply terminal theme changes directly to the xterm instance. A
   theme reconciliation path already exists —
   `reconcileTerminalRenderer(term, cached, useThemeStore.getState().theme)`
   at `TerminalView.tsx:245` — extend it rather than adding a second one.
3. Backend: `set_theme` updates the VT `ColorScheme` and writes the program
   response, and stops publishing a replay.
4. Formatter: drop `.with_palette(true)` from the ordinary replay path,
   preserving whatever H8.2 shows must be kept — carrying provenance per slot
   across both the indexed and the default families, not one aggregate flag.
5. Publish the theme as a sequenced `PaletteChanged` marker carrying a
   framework-neutral render theme and a monotonic revision — not xterm's
   `ITheme`, which must not cross the backend domain boundary. Apply it
   through the ordered renderer queue built in phase 07. That queue's
   `OutputTerminal` type widens from `Pick<Terminal, "write">`
   (`terminalOutputQueue.ts:5`) to include `options`; keep the widening to
   exactly what the barrier needs so test doubles stay small.
6. Resolve H8.5. If hidden application is unsafe, pause the queue at the
   barrier until reveal; never skip the marker.

## Acceptance criteria

- A theme change produces no `TerminalEvent::Replay`, and yields exactly one
  ordered `PaletteChanged` marker after host state changes.
- Palette bytes authored by the child before the marker drain before it;
  bytes after it follow it. Rapid A → B applies each payload in order.
- A theme changed while hidden preserves stream order and viewport.
- Replay size for a fixed fixture drops by the factor measured in H8.1, and
  that factor is recorded in the test.
- Program-set palette state round-trips through attach for both families,
  proven by the two H8.2 fixtures: after a theme change, theme-owned slots
  adopt the new theme and child-overridden slots stay child-owned.
- Renderer mode and transparency never appear in a backend type or on the
  wire; an xterm with no live attachment still gets them.
- If the hidden barrier pauses, the recoveries caused by one theme change are
  counted in a test and bounded.
- Dropping the palette does not change rendered output once the renderer
  applies the theme itself.

## Validation

```sh
just test rust      # formatter fixtures, size assertions, degradation ladder
just test fast      # renderer theme application
just check all
```

Manual: switch light/dark with a terminal holding several thousand lines of
history. Expected: instant repaint including scrollback, no flash, no reset,
no history loss.

## Rollback

Independent of phase 09. If H8.5 shows hidden application cannot be made safe
even with a paused barrier, keep the existing reveal-time deferral in
`TerminalView.tsx:293,304-305` and ship the rest of this phase; the ordering
guarantee does not depend on when the hidden case is applied.

## Out of scope

Bounding or restructuring the replay payload — phase 09. Recoloring archived
history through a translation table: openmux needs that because its cells
store absolute RGB in a disk archive; shipctl's renderer holds the buffer and
xterm repaints it from the theme directly.
