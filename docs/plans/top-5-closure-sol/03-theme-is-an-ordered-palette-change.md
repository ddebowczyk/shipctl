# Theme is an ordered palette change

## Outcome

Changing the application theme updates the host's semantic/query-visible
palette and xterm's presentation without resetting, replaying, or rebuilding
terminal contents. Palette changes participate in the same order as PTY output.

## Context and purpose

Theme changes currently publish replay. That makes an application presentation
choice a content-reconstruction event and can erase continuity across every
open terminal.

Simply setting `term.options.theme` independently is also insufficient. A
child can change indexed colors and defaults through OSC output. Those bytes
must remain ordered relative to the application palette change. Renderer addon
selection and transparency are presentation policy and must not leak into Rust
domain types.

The target separates two concepts:

- `TerminalPaletteTheme`: semantic terminal colors and the monotonic app-theme
  revision used by host queries and ordered palette application;
- `TerminalRendererPolicy`: frontend-only transparency, WebGL/addon selection,
  and other renderer mechanics.

## Dependencies

- The preparatory protocol and controller changes are complete.
- [Visibility is presentation only](01-visibility-is-presentation-only.md) is
  complete so hidden terminals have a defined live-stream contract.
- [Resize is an ordered boundary](02-resize-is-an-ordered-boundary.md) has
  supplied the ordered renderer-operation queue.

## Affected areas

- `core/backend/src/terminal/replay.rs`
- `core/backend/src/terminal/runtime.rs`
- `core/backend/src/terminal/types.rs`
- `core/backend/src/terminal/service.rs`
- terminal protocol adapters
- the preparatory attachment controller
- `core/frontend/terminal/terminalColorTheme.ts`
- `core/frontend/terminal/terminalTheme.ts`
- `core/frontend/terminal/terminalRenderer.ts`
- `core/frontend/terminal/terminalRendererAddons.ts`
- `core/frontend/terminal/terminalOutputQueue.ts`
- `core/frontend/terminal/useTerminalSettingsStore.ts`
- terminal theme, protocol, queue, and controller tests

## Work to be done

1. Define a framework-neutral semantic palette type and a sequenced
   `PaletteChanged` event. Carry the theme revision selected at request time;
   never read whichever theme happens to be newest when an older marker arrives.
2. Keep xterm `ITheme`, transparency, renderer names, and addon instances out
   of backend and wire-domain types. Represent those in a separate frontend
   renderer policy keyed by the same app-theme revision.
3. Change the backend theme command to:
   - reject or supersede stale revisions according to the service policy;
   - update Ghostty's child-query-visible semantic defaults;
   - emit any required terminal response;
   - allocate the next event sequence; and
   - publish one `PaletteChanged` marker.
4. Remove replay creation, replay-change bookkeeping, and replay publication
   from the theme path.
5. Apply `PaletteChanged` through the ordered renderer-operation queue. Drain
   earlier writes, apply the exact semantic palette and renderer policy for the
   marker's revision, then release later output.
6. Preserve provenance for both terminal-authored color families:
   - OSC 4 indexed palette entries; and
   - OSC 10, 11, and 12 foreground, background, and cursor defaults.
   A later app theme changes theme-owned values without erasing supported child
   overrides.
7. Retain a frontend revision-to-policy mapping until attached queues have
   consumed or superseded each revision. Rapid A -> B changes must apply A's
   policy at A's marker and B's policy at B's marker.
8. Give never-attached renderers the current frontend renderer policy locally
   and the current semantic palette through their initial snapshot.
9. Reproduce the existing hidden-xterm theme hazard against the pinned xterm
   version. Prefer a layout-safe hidden application path that lets the ordered
   queue continue draining.
10. If safe hidden palette application is impossible, pause only at the palette
    barrier until reveal within the established queue bound. Actual overflow
    follows the visibility plan's single-pending-recovery rule. Reject a design
    that predictably converts ordinary global theme changes into recoveries.
11. Add fixtures for visible and hidden changes, rapid A -> B transitions,
    output and OSC mutations on each side of a palette marker, history,
    selection, cursor, indexed/default/RGB colors, host color queries, and addon
    swaps.

## Acceptance criteria

- Theme changes publish no replay and invoke no `term.reset()`.
- Each accepted theme revision yields one sequenced `PaletteChanged` marker
  after host semantic/query state changes.
- PTY color mutations before the marker drain before palette application;
  mutations after it are applied later.
- Rapid theme changes apply each marker's exact palette and renderer policy. An
  old marker cannot accidentally read the newest frontend store value.
- Theme changes preserve content, cursor, modes, retained history, viewport,
  selection, hyperlinks, and supported child-authored color overrides.
- Theme-owned colors and host query responses adopt the accepted current theme.
- Transparency and renderer-addon policy remain frontend-only and work for
  both attached and never-attached renderers.
- Visible and hidden terminals preserve sequence and viewport across a global
  theme change. Ordinary supported output causes no recovery; actual overflow
  causes at most one pending recovery for each affected hidden terminal.
- Attach, gap, renderer-recreation, and overflow recovery remain functional and
  install the correct current palette without freezing an earlier app theme.

## How to validate

```sh
cargo test --manifest-path core/backend/Cargo.toml terminal::replay
cargo test --manifest-path core/backend/Cargo.toml terminal::runtime
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts \
  core/frontend/terminal/tests/terminalOutputQueue.test.ts \
  core/frontend/terminal/tests/terminalTheme.test.ts \
  core/frontend/terminal/tests/terminalProtocol.test.ts \
  core/frontend/terminal/tests/terminalVisibility.test.ts
./research/20260809-124553-fut-tty/vt-proof/run.sh
just test fast
just test rust
just check all
git diff --check
```

The tests must delay prior xterm writes and issue rapid theme revisions to
prove ordering and revision fidelity, not merely inspect the final palette.

## Exit and rollback

Exit when semantic palette state, child overrides, renderer policy, and hidden
delivery remain ordered without reconstruction. Replay-on-theme is not a valid
rollback. A hidden application issue belongs to the presentation seam or the
bounded overflow contract.
