# Theme is an ordered palette change

## Outcome

Changing the application theme updates Ghostty's semantic and query-visible
palette and xterm's presentation without resetting, replaying, or rebuilding
terminal contents. Palette changes participate in the same order as PTY output.

## Context and purpose

Theme changes currently publish replay. This turns an application presentation
choice into a content-reconstruction event for every open terminal.

Setting `term.options.theme` directly is not a sufficient replacement. A child
can change indexed colors and defaults through OSC output, and those bytes must
stay ordered relative to the application palette change. Renderer selection,
transparency, and addon configuration are frontend presentation policy and must
not leak into the Rust domain protocol.

The target separates two concepts:

- `TerminalPaletteTheme`: framework-neutral semantic colors and a monotonic
  app-theme revision used for host queries and ordered palette application;
- `TerminalRendererPolicy`: frontend-only transparency, renderer and addon
  choices, and other xterm mechanics keyed by the same revision.

## Dependencies

- The preparatory semantic protocol and attachment controller are complete.
- [Visibility is presentation only](01-visibility-is-presentation-only.md) is
  complete, so hidden terminals have a defined live-stream contract.
- [Resize is an ordered boundary](02-resize-is-an-ordered-boundary.md) has
  supplied the ordered renderer-operation queue.

## Affected areas

- `core/backend/src/terminal/replay.rs`
- `core/backend/src/terminal/runtime.rs`
- `core/backend/src/terminal/types.rs`
- `core/backend/src/terminal/service.rs`
- Tauri, instance control-socket, and CLI protocol adapters
- the preparatory attachment controller
- `core/frontend/terminal/terminalColorTheme.ts`
- `core/frontend/terminal/terminalTheme.ts`
- `core/frontend/terminal/terminalRenderer.ts`
- `core/frontend/terminal/terminalRendererAddons.ts`
- `core/frontend/terminal/terminalOutputQueue.ts`
- `core/frontend/terminal/useTerminalSettingsStore.ts`
- terminal theme, protocol, queue, controller, and visibility tests

## Work to be done

1. Define a framework-neutral semantic palette type and a sequenced
   `PaletteChanged` event. Carry the revision selected at request time; never
   read whichever theme is newest when an older marker reaches the renderer.
2. Keep xterm `ITheme`, transparency, renderer names, and addon instances out
   of backend and wire-domain types. Map the same app-theme revision to a
   separate frontend renderer policy.
3. Make the backend theme command reject or supersede stale revisions according
   to the service policy, update Ghostty's child-query-visible semantic state,
   emit any required terminal response, allocate the next sequence, and publish
   one `PaletteChanged` marker in the same actor turn.
4. Remove replay creation, replay bookkeeping, and replay publication from the
   theme path. Remove visibility catch-up and direct-store paths that can
   independently assert the semantic palette.
5. Apply `PaletteChanged` through the ordered renderer-operation queue. Drain
   earlier writes, apply the exact semantic palette and renderer policy for the
   marker's revision, and only then release later output.
6. Preserve provenance for terminal-authored colors: OSC 4 indexed entries and
   OSC 10, 11, and 12 foreground, background, and cursor defaults. A later app
   theme updates theme-owned values without erasing supported child overrides.
7. Retain the frontend revision-to-policy mapping until attached queues consume
   or supersede each revision. Rapid A to B transitions must apply A's policy
   at A's marker and B's policy at B's marker.
8. Initialize never-attached renderers with the current frontend renderer
   policy and the semantic palette carried in their initial snapshot.
9. Reproduce the hidden-xterm theme hazard against the pinned xterm version.
   Prefer a layout-safe hidden apply path that permits the ordered queue to
   continue draining without avoidable DOM work.
10. If safe hidden palette application is impossible, pause only at that
    palette barrier until reveal and stay within the measured queue bound.
    Actual overflow follows the visibility plan's one-pending-recovery rule.
    Reject behavior that predictably turns global theme changes into recovery.
11. Add fixtures for visible and hidden changes, rapid revisions, PTY output
    and OSC mutations on both sides of a marker, history, selection, cursor,
    indexed and default colors, host queries, and addon swaps. Include a global
    theme change across multiple hidden terminals under sustained output and
    prove that queues stay within the measured bound without scheduling
    recovery.

## Acceptance criteria

- Theme changes publish no replay and invoke no `term.reset()`.
- Each accepted revision yields one `PaletteChanged` marker after host semantic
  and query state changes.
- PTY color mutations before the marker drain before palette application;
  mutations after it are applied later.
- Rapid theme changes apply each marker's exact semantic palette and renderer
  policy. An old marker cannot read the newest frontend store value.
- xterm applies semantic palette state only from the ordered marker, never from
  an acknowledgement, visibility catch-up, or direct store subscription.
- Theme changes preserve contents, cursor, modes, retained history, viewport,
  selection, hyperlinks, and supported child-authored color overrides.
- Theme-owned colors and host query responses adopt the accepted current theme.
- Transparency and renderer-addon policy remain frontend-only and work for
  attached and never-attached renderers.
- Visible and hidden terminals preserve sequence and viewport during a global
  theme change. Ordinary output causes no recovery; actual overflow schedules
  at most one pending recovery for each affected attachment.
- Attach, gap, renderer-recreation, and overflow recovery install the current
  palette without freezing an earlier app theme.

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
just test vt-divergence
just test fast
just test rust
just check all
git diff --check
```

Tests must delay earlier xterm writes, issue rapid theme revisions, and assert
the operation order and revision fidelity rather than only the final palette.
Exercise the same marker through Tauri, the instance control socket, and the
CLI decoder.

## Exit and rollback

Exit only when semantic state, child overrides, renderer policy, and hidden
delivery remain ordered without reconstruction. Replay on theme is not a
rollback. A hidden-application defect belongs to the presentation seam or the
bounded overflow contract.
