# Resize is an ordered boundary

## Outcome

Geometry changes become ordered live terminal operations. The host changes the
PTY, Ghostty state, and descriptor first; xterm changes geometry at the matching
sequenced marker after all earlier output has drained. Resize never
reconstructs terminal contents.

## Context and purpose

The backend resize path currently publishes replay, while the frontend can
resize xterm from the request path. Removing replay without replacing this
ordering would allow the same output to cross the geometry boundary differently
in Ghostty and xterm.

The canonical operation is:

```text
validate resize authority
-> resize PTY
-> resize Ghostty
-> update descriptor and geometry revision
-> allocate the next attachment sequence
-> publish Resized(sequence, revision, columns, rows)
-> resolve the request acknowledgement
```

The acknowledgement exists for request coordination. It never mutates xterm.
The sequenced marker is the sole renderer authority for canonical geometry.

## Dependencies

- The preparatory controller, semantic protocol, raw codec, and single-writer
  work are complete.
- [Visibility is presentation only](01-visibility-is-presentation-only.md) is
  complete.
- The baseline VT corpus includes the known wrap-boundary divergence and output
  immediately before and after resize.

## Affected areas

- `core/backend/src/terminal/runtime.rs`
- `core/backend/src/terminal/types.rs`
- `core/backend/src/terminal/commands.rs`
- `core/backend/src/terminal/service.rs`
- Tauri, instance control-socket, and CLI protocol adapters
- the preparatory attachment controller
- `core/frontend/terminal/TerminalView.tsx`
- `core/frontend/terminal/terminalOutputQueue.ts`
- `core/frontend/terminal/terminalViewport.ts`
- terminal runtime, protocol, controller, queue, and viewport tests
- the durable VT divergence corpus and its operations recipe

## Work to be done

1. Add a sequenced `Resized` domain event carrying canonical columns, rows,
   geometry revision, and the stream's existing terminal, attachment, and
   sequence identity where each adapter requires them. Include it in every
   adapter, gap rule, decoder, and compatibility fixture.
2. Make the backend actor perform the canonical operation above in one actor
   turn. Output observed before the operation precedes the marker; output
   observed after it follows the marker.
3. Return a typed acknowledgement containing canonical geometry and whether the
   request changed state. Publish no marker when the requested geometry equals
   the current canonical geometry.
4. Remove replay construction, replay bookkeeping, and replay publication from
   resize. Remove request, acknowledgement, and direct-store paths that can
   independently apply canonical geometry.
5. Generalize the byte-only frontend output queue into an ordered renderer-
   operation queue. A resize barrier waits for all earlier xterm write
   callbacks, invokes `term.resize()`, and only then releases later output.
6. Use `FitAddon.proposeDimensions()` to propose desired geometry. Do not call
   `fitAddon.fit()` or `term.resize()` until the controller consumes the host's
   matching `Resized` marker.
7. Apply the marker through viewport preservation so anchored history,
   selection, and pinned-to-bottom behavior survive reflow.
8. Coalesce drag requests without discarding accepted markers: permit one
   request in flight for an attachment, retain the newest desired geometry,
   issue it after acknowledgement only when it differs from canonical state,
   and consume every sequenced marker even when a newer request is pending.
9. Remeasure the current resize scheduling policy after replay is removed.
   Keep a delay only when a supported workload proves it is necessary, and
   record the measurement and authority for its value.
10. Measure proposal through marker receipt, prior-write drain, and xterm apply
    under idle output, sustained output, and drag. Compare the result with the
    owner-approved interaction contract. Improve coalescing or visual feedback
    if needed; do not reintroduce optimistic model resize.
11. Implement resize-window child-clear suppression only if a checked-in trace
    proves the exact supported failure. Bind any filter to the ordered resize
    generation and the proven byte signature.

## Acceptance criteria

- Resize publishes no replay and invokes no `term.reset()`.
- Every changed canonical geometry yields one `Resized` marker after the PTY,
  Ghostty, and descriptor change; a no-op yields none.
- Output on both sides of the marker is parsed at the same geometry by Ghostty
  and xterm, including when an earlier xterm write callback is delayed.
- xterm geometry changes only from the ordered marker, never from the request,
  acknowledgement, visibility, or store path.
- Drag converges to the newest desired geometry with one in-flight request, no
  stale request backlog, and no skipped sequenced marker.
- Width, height, and drag changes preserve retained history, viewport policy,
  selection, modes, supported Unicode, contents, and the approved cursor
  contract.
- A hidden terminal's geometry converges through the host marker without
  reconstructing terminal contents when it is revealed.
- Scheduling and interaction behavior have checked-in measurements and named
  product approval; no inherited debounce value becomes an implicit contract.
- No child-clear filter exists without its corresponding failing and passing
  fixture.
- The standing differential corpus proves the accepted live convergence
  boundary. Failure blocks cutover instead of restoring routine replay.

## How to validate

```sh
cargo test --manifest-path core/backend/Cargo.toml terminal::runtime
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts \
  core/frontend/terminal/tests/terminalOutputQueue.test.ts \
  core/frontend/terminal/tests/terminalScrollPin.test.ts \
  core/frontend/terminal/tests/terminalProtocol.test.ts
just test vt-divergence
just test fast
just test rust
just check all
git diff --check
```

Add deterministic tests that hold an xterm write callback, place output before
and after `Resized`, and assert the observed operation order rather than merely
the final dimensions. Exercise the same event through Tauri, the instance
control socket, and the CLI decoder.

## Exit and rollback

Exit only when the ordered path meets the approved convergence and interaction
contracts. Replay on resize and optimistic local resize are not rollback
options. If the two parsers cannot meet the gate, retain the evidence and
activate the host-cell renderer decision in the convergence plan.
