# Phase 04 — Make resize ordered and theme non-destructive

## Outcome

Remove routine reset/replay boundaries. Resize and palette changes become
ordered live-stream events applied after the host changes canonical state.
Neither reconstructs terminal contents.

## Context

Calling `term.resize()` before the host actor processes the resize can place
output on opposite sides of the geometry boundary in the two parsers. Merely
stopping backend replay is therefore insufficient. cmux avoids this ambiguity
by ordering `Resized` beside output and letting clients mutate geometry when
that frame is consumed.

`applyTerminalSize` already wraps local resize in viewport preservation, but
the subsequent replay reset discards that work. This phase makes the viewport
preservation path effective.

## Protocol rule

For a changed geometry, the backend actor performs one serial operation:

```text
validate authority
-> PTY resize
-> Ghostty resize
-> descriptor update
-> sequence += 1
-> publish Resized(sequence, revision, columns, rows)
-> resolve invoke acknowledgement
```

Output read before the operation precedes `Resized`; output read after it
follows `Resized`. The acknowledgement may drive coalescing, but it never
causes the renderer resize independently of the sequenced frame.

The frontend preserves the same boundary in its asynchronous xterm queue.
`Resized` is an ordered queue barrier: every earlier `term.write` callback
finishes, then xterm resizes, then later output may be written. Receiving the
channel event is not enough if earlier bytes are still waiting inside xterm.

Theme uses the same rule because OSC palette/default mutations arrive as PTY
output. The actor updates Ghostty's semantic/query state, sends any child
response, and publishes a sequenced `PaletteChanged`. The renderer drains
earlier writes, applies that palette plus the matching frontend-only renderer
policy without reset, then releases later output. Transparency and WebGL-addon
selection never enter the Rust domain.

## Hypotheses to verify

### H4.1 — Actor ordering

The actor gives `Output` and `Resized` one unambiguous order. Inject output
before, during, and after a blocked resize; assert sequence and parse geometry.
Falsifier: a frame crosses the marker and parses at different geometries.

### H4.2 — Live convergence

The Phase 01 convergence contract holds without replay. Run all VT resize
fixtures through host and xterm with ordered markers. Falsifier: supported state
remains divergent beyond the agreed redraw boundary.

### H4.3 — Local theme repaint

Setting `term.options.theme` repaints default/indexed colors without reset. Test
default/indexed/RGB cells, history, selection, and cursor. Falsifier: supported
palette behavior requires content reconstruction.

### H4.4 — Host query state

Host theme updates remain necessary for OSC queries and DEC 2031 reports. Query
before/after theme and inspect child-visible response bytes. Falsifier: host
theme has no child-visible responsibility.

### H4.5 — Hidden palette safety on xterm 6

Applying `term.options.theme` under `display:none` corrupts xterm scroll state,
as the current source comment reports. Reproduce it against pinned
`@xterm/xterm` 6.0.0 with a numbered, scrolled buffer; the comment predates that
major and is not evidence by itself. Falsifier: hidden and visible theme
updates produce identical buffer/viewport state across the fixture.

### H4.6 — Resize debounce remains justified

Measure `proposeDimensions`, local xterm reflow, and ordered host resize during
row-only, column-only, and drag workloads at the supported 1k-50k scrollback
settings. Falsifier: the current immediate-row/debounced-column split no longer
improves latency or work after replay/reset is removed.

### H4.7 — Ordered resize latency

Measure desired-size proposal -> host marker -> prior-write drain -> xterm
resize completion under idle, sustained-output, and drag workloads. Record
p50, p95, and maximum against an owner-approved interaction budget. Falsifier:
the host round-trip makes supported drag visibly lag or miss the product gate.

## Tasks

1. Add sequenced `TerminalEvent::Resized` and `PaletteChanged` variants. Include
   both in the same sequence extraction, subscriber queue, and gap rules as
   `Output` and `Replay`.
2. Change backend `resize` to publish `Resized` after PTY, Ghostty, and
   descriptor mutation. Publish nothing for an exact same-size no-op; return a
   typed acknowledgement containing canonical geometry and `changed`.
3. Remove replay creation, replay-change bookkeeping, and `Replay` publication
   from backend resize.
4. Generalize `TerminalOutputQueue` into an ordered renderer-operation queue
   that accepts byte writes, resize barriers, and palette barriers. Each barrier
   waits for all prior xterm writes, mutates renderer state, then releases later
   writes.
5. Replace `fitAddon.fit()` on the request path with
   `fitAddon.proposeDimensions()`. Send the desired size, but call
   `term.resize()` only when the controller consumes the sequenced `Resized`
   event through that renderer queue.
6. Apply `Resized` through `preserveTerminalViewport`. Retain the current
   column debounce until H4.6 justifies a different policy; use
   latest-desired-size coalescing so a drag cannot accumulate stale requests.
   Record the retained or replacement policy and its measured authority.
7. Define multiple-resize behavior:
   - one resize invoke in flight per attachment;
   - remember only the newest desired geometry;
   - after acknowledgement, issue it only if it differs from the latest
     canonical geometry; and
   - accept every sequenced marker even if a newer request is already pending.
8. Define a framework-neutral `TerminalPaletteTheme` containing only semantic
   terminal colors/defaults and the app-theme revision selected at request
   time. Separately define frontend-only `TerminalRendererPolicy` for
   transparency and renderer-addon selection. The revision is monotonic; do
   not pass xterm's `ITheme`, transparency, or addon names through Rust.
9. Change backend `set_theme` to apply the host/query palette, write the DEC
   report response, remove replay bookkeeping, increment sequence, and publish
   that semantic palette in one `PaletteChanged` marker. The service ignores a
   stale app-theme revision so concurrent invocations cannot roll B back to A.
10. Split `useThemeApplicator`: global CSS and frontend renderer policy may be
    stored immediately, but an attached terminal applies its palette and addon
    swap only when the matching `PaletteChanged` revision reaches its ordered
    queue position. A never-attached renderer obtains current frontend renderer
    policy locally and semantic palette from its initial snapshot; it does not
    need a live attachment to select an addon.
11. Apply `PaletteChanged` through the ordered renderer queue. Add fixtures for
    app-authored RGB/palette mutations and rapid theme A -> B. If full theme
    replacement erases app-owned overrides, carry sparse semantic override
    metadata rather than replaying VT content.
12. Resolve H4.5 explicitly. Prefer a layout-safe hidden surface or another
    xterm-6-supported application path that lets every queue keep draining. If
    no safe hidden application exists, pause only at the palette barrier until
    reveal, within the existing buffer bound. Test one global theme change over
    multiple hidden terminals under sustained output: normal load causes zero
    recoveries; actual overflow causes at most one pending recovery per affected
    terminal and never a repeated reattach storm.
13. Delete or simplify code made dead by the new contract, including any replay
   scheduling reachable only from resize/theme. Preserve replay for initial
   attach, xterm-model recreation, gap, and overflow.
14. Implement resize-window clear suppression only if Phase 01 H5 produced a
    supported failing fixture. Scope it to the ordered resize generation and
    exact proven byte signature. Use a timer only if the generation boundary is
    demonstrably insufficient, with its value derived from the trace; otherwise
    add no suppression code.
15. Instrument H4.7 from `proposeDimensions()` through marker consumption and
    `term.resize()` completion. If it misses the interaction budget, mitigate
    with presentational drag feedback and request coalescing. Do not resize the
    xterm terminal model optimistically before the host marker.

## Acceptance criteria

- Resize and theme publish no `Replay` event and invoke no `term.reset()`.
- Every changed geometry yields exactly one sequenced `Resized` event after the
  host has applied the canonical size; a no-op resize yields none.
- Output on each side of a resize marker is parsed at the same geometry by the
  host and xterm, even when preceding xterm writes are artificially delayed.
- Rapid drag resize converges to the latest desired geometry with at most one
  in-flight request and no stale-size replay or request queue.
- The row/column debounce policy is backed by the post-replay-removal benchmark;
  no delay or history threshold survives only because the old reset path used
  it.
- Ordered resize satisfies the recorded proposal-to-application latency budget
  under idle, output, and drag workloads. Any mitigation is presentational or
  coalescing-only and does not introduce optimistic model resize.
- Repeated row-only and column changes preserve scrollback, anchored viewport,
  selection, modes, and supported content according to the Phase 01 proof.
- Each changed theme yields one ordered `PaletteChanged` marker after host state
  changes. Prior OSC palette bytes drain before it; later bytes follow it.
- Rapid theme requests apply the exact payload for each marker in order; an old
  marker never reads the newest theme implicitly from the frontend store.
- A theme changed while hidden preserves stream order and viewport. A global
  theme change across multiple hidden output-producing terminals causes no
  recovery under the supported bound and at most one recovery for each terminal
  that actually overflows; it never causes repeated recovery loops.
- Rust protocol/domain types contain semantic palette values only. Transparency
  and renderer-addon choice remain frontend-only and work for never-attached
  terminals.
- Theme changes preserve contents, cursor, history, selection, and app-owned
  colors while changing theme-owned colors and child-visible query defaults.
- Attach/gap/overflow recovery continues to reset and replay exactly once.
- No child clear-sequence filter exists unless its Phase 01 failing fixture is
  checked in and now passes.

## Validation

```sh
cargo test --manifest-path core/backend/Cargo.toml terminal::runtime
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts \
  core/frontend/terminal/tests/terminalScrollPin.test.ts
./research/20260809-124553-fut-tty/vt-proof/run.sh
just test fast
just test rust
just check all
git diff --check
```

## Exit and rollback

If ordered live resize fails the Phase 01 product gate, stop and reopen the
cell-renderer architecture. Do not use replay-on-every-resize as a silent
rollback, because it restores the original history-loss defect.
