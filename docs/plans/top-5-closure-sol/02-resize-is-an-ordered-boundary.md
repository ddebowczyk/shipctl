# Resize is an ordered boundary

## Outcome

Geometry changes become ordered live terminal operations. The host changes the
PTY and Ghostty state first; xterm changes geometry at the matching sequenced
marker after all earlier output has drained. Resize never reconstructs terminal
contents.

## Context and purpose

The backend currently publishes replay after resize, and the frontend can
resize xterm from the request path. Removing replay without replacing this
ordering would leave output free to cross the geometry boundary differently in
Ghostty and xterm.

The canonical operation for a changed geometry is:

```text
validate resize authority
-> resize PTY
-> resize Ghostty
-> update descriptor and revision
-> allocate next sequence
-> publish Resized(sequence, revision, columns, rows)
-> resolve acknowledgement
```

The invoke acknowledgement supports request coalescing only. It never mutates
the xterm model. The sequenced marker is the renderer authority.

## Dependencies

- The preparatory controller, semantic protocol, raw codec, and state-authority
  work are complete.
- [Visibility is presentation only](01-visibility-is-presentation-only.md) is
  complete.
- The baseline VT corpus contains the known wrap-boundary divergence and output
  immediately before and after resize.

## Affected areas

- `core/backend/src/terminal/runtime.rs`
- `core/backend/src/terminal/types.rs`
- `core/backend/src/terminal/commands.rs`
- `core/backend/src/terminal/service.rs`
- the raw Tauri and control-socket protocol adapters
- the preparatory attachment controller
- `core/frontend/terminal/TerminalView.tsx`
- `core/frontend/terminal/terminalOutputQueue.ts`
- `core/frontend/terminal/terminalViewport.ts`
- terminal protocol and controller tests
- `research/20260809-124553-fut-tty/vt-proof`

## Work to be done

1. Add a sequenced `Resized` domain event carrying canonical columns, rows,
   descriptor revision, and the attachment stream's normal sequence metadata.
   Include it in every adapter, gap rule, and compatibility fixture.
2. Change the backend actor's resize command to perform the canonical operation
   above in one actor turn. Output observed before the operation must precede
   the marker; output observed after it must follow the marker.
3. Return a typed acknowledgement containing canonical geometry and whether the
   operation changed state. Publish no marker for an exact same-size request.
4. Remove replay construction, replay-change bookkeeping, and replay
   publication from the resize path.
5. Generalize the byte-only frontend output queue into an ordered renderer
   operation queue. A resize barrier waits for all prior xterm write callbacks,
   invokes `term.resize()`, and only then releases later output.
6. Use `FitAddon.proposeDimensions()` on the request path. Do not call
   `fitAddon.fit()` or `term.resize()` until the controller consumes the
   canonical `Resized` marker.
7. Apply the marker through viewport preservation so anchored history,
   selection, and pinned-to-bottom behavior survive reflow.
8. Coalesce drag requests without discarding accepted markers:
   - allow one resize request in flight per attachment;
   - retain only the newest desired geometry for the next request;
   - issue it after acknowledgement only when it differs from canonical state;
   - consume every sequenced marker even if a newer request is pending.
9. Remeasure the existing row/column scheduling policy after replay removal.
   Retain a delay only when the measured supported workload requires it; record
   the authority for any resulting value.
10. Measure desired-size proposal through marker receipt, prior-write drain, and
    xterm resize under idle output, sustained output, and drag. Compare with an
    owner-approved interaction budget. If needed, improve coalescing or visual
    drag feedback without optimistic model resize.
11. Implement resize-window child clear suppression only if the existing trace
    work provides an exact reproducible failing sequence. Bind any suppression
    to the ordered resize generation and proven byte signature.

## Acceptance criteria

- Resize publishes no replay and invokes no `term.reset()`.
- Every changed canonical geometry yields one `Resized` marker after the PTY,
  Ghostty, and descriptor have changed. A no-op produces no marker.
- Output on both sides of the marker is parsed at the same geometry by Ghostty
  and xterm even when earlier xterm writes are deliberately delayed.
- xterm never changes its terminal model from the resize request or
  acknowledgement path.
- A drag converges to the newest requested geometry with one in-flight request,
  no stale request backlog, and no skipped sequenced marker.
- Height, width, and drag changes preserve retained history, viewport policy,
  selection, modes, cursor contract, supported Unicode, and content.
- The post-change scheduling and latency decisions have checked-in measurements
  and an explicit product authority; no old debounce survives by inertia.
- No child clear-sequence filter exists without the corresponding failing and
  now-passing fixture.
- The differential corpus proves the accepted live convergence boundary. A
  broad failure blocks cutover rather than re-enabling routine replay.

## How to validate

```sh
cargo test --manifest-path core/backend/Cargo.toml terminal::runtime
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts \
  core/frontend/terminal/tests/terminalOutputQueue.test.ts \
  core/frontend/terminal/tests/terminalScrollPin.test.ts \
  core/frontend/terminal/tests/terminalProtocol.test.ts
./research/20260809-124553-fut-tty/vt-proof/run.sh
just test fast
just test rust
just check all
git diff --check
```

Add deterministic tests that block an xterm write callback, place output on
both sides of `Resized`, and prove the barrier rather than only the final size.

## Exit and rollback

Exit only when the ordered path meets the product convergence and interaction
gates. Replay-on-resize is not a valid rollback. If the two parsers cannot meet
the gate, preserve the evidence and reopen the host-cell renderer decision in
the final convergence plan.
