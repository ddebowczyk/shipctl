# Terminal continuity closure end state

## Outcome

Shipctl keeps xterm.js as the interactive renderer and live VT mirror and
libghostty-vt as the durable terminal and recovery authority. They operate as
one ordered system: ordinary output, geometry, palette, lifecycle, and recovery
all cross one terminal-runtime-scoped sequence, while reset plus snapshot
install is reserved for four explicit recovery boundaries.

This is the selected architecture, not an evaluation of several alternatives.
Herdr's host-cell renderer is the escalation architecture only if the standing
dual-parser convergence gate rejects this one.

```text
PTY
  -> TerminalRuntime + libghostty-vt
       durable state, history, canonical facts, sequence, terminal UUID
  -> one ordered attachment stream
       output + resized + palette + lifecycle + recovery
  -> TerminalAttachmentController
       generation, order, readiness, renderer queue, recovery
  -> xterm.js
       disposable live model, rendering, selection, viewport, links
```

## Context and purpose

The root cause is not merely that Shipctl has two VT parsers. It is that
Ghostty and xterm currently evolve terminal state without one complete
contract for authority, order, visibility, and recovery. Host replay followed
by `term.reset()` became the general convergence mechanism, so routine
presentation changes became terminal reconstruction events:

- resize triggers reset and replay;
- theme changes trigger reset and replay; and
- hide and show controls attachment lifetime, producing detach, attach, reset,
  and replay.

The misread `max_scrollback` byte budget explains the severe history-retention
symptom. The preparatory retention work fixes that defect, but it does not fix
the missing authority and ordering contract. This plan closes that root cause.

## Authority contract

The split below is normative and must be enforceable in code and tests.

- The backend actor and Ghostty own the PTY, durable VT state, retained
  history, lifecycle, canonical geometry, semantic and query-visible palette,
  sequence, terminal identity, and recovery snapshot. They do not own renderer
  implementation, selection, viewport presentation, or addon policy.
- The attachment controller owns attachment generation, expected sequence,
  readiness, ordered renderer delivery, recovery coalescing, and the
  queue-overflow transition. It does not establish terminal facts independently
  of the backend stream.
- The xterm view owns its disposable live VT model, drawing, selection,
  viewport, hyperlink presentation, renderer, and addon policy. It does not own
  canonical geometry, lifecycle, retention, semantic palette, or recovery
  boundaries.

xterm may mutate its geometry or palette only while consuming the matching
ordered host marker. Request acknowledgements, React state, visibility events,
and direct store reads cannot independently assert those host-owned facts.

## Exact recovery boundaries

Reset and snapshot installation are permitted only for:

1. initial attachment or first reveal of a never-attached renderer;
2. deliberate xterm-model recreation;
3. a detected sequence gap; and
4. bounded attachment-queue overflow.

Resize, theme change, normal hide and show, overlays, focus changes, and
ordinary descriptor updates are not recovery boundaries.

A backend-process restart is not a fifth recovery boundary in the current
product contract. Shutdown terminates every in-memory terminal runtime, and a
new service creates fresh non-reused UUIDs. The frontend controller restarts
with the application; a remote client holding an old UUID receives terminal
absence rather than recovering that destroyed runtime. If terminals later gain
cross-process survival, that feature must first introduce an explicit runtime
identity and extend this contract.

Every recovery installs a complete snapshot at sequence `N`. Frames at or
before `N` are discarded, frames after `N` wait for the snapshot to finish,
and delivery resumes at `N + 1` without duplication. The snapshot contains a
bounded newest complete history suffix and the complete active state. It
reports host eviction and snapshot omission independently.

## Live convergence contract

Between recovery boundaries, Ghostty and xterm consume the same PTY output and
the same ordered state transitions. xterm changes geometry only after earlier
writes have drained and the host `Resized` marker reaches the renderer queue.
It applies semantic palette state only at the matching `PaletteChanged` marker.
Visibility affects DOM work, not stream consumption.

The known cursor-placement difference at a reflow-wrap boundary is acceptable
only while the checked-in differential corpus proves it remains inside the
owner-approved product contract. The corpus is a continuous compatibility
gate, not a one-time migration test. A broader or user-visible failure blocks
cutover or reopens the host-cell renderer escalation; it is never hidden by
selectively restoring routine replay.

## Escalation inventory

The escalation decision must use the actual cost of replacing xterm and the
actual backend consumers of Ghostty state.

Current host screen-state consumers to preserve or replace:

- initial-attachment and recovery snapshot production;
- control-socket and CLI replay transport;
- terminal query responses derived while Ghostty consumes PTY output and theme
  state; and
- canonical resize reflow retained for later recovery.

No current host-side copy, search, or link consumer has been identified. The
inventory must be updated if implementation work finds one.

Current xterm capabilities to preserve or explicitly replace:

- live VT parsing and buffer state;
- DOM and WebGL rendering;
- Unicode 11 handling;
- web-link detection;
- geometry proposal through the fit addon;
- selection, viewport, buffer, and input APIs.

Search is a cited reason to retain xterm, but the current source inventory does
not show an installed search addon. Confirm the product requirement and actual
integration before including search in the cost of a host-cell escalation.

## Dependencies

This closure begins only after the exit gate in
[`terminal-top-5-changes-sol`](../terminal-top-5-changes-sol/README.md) is met:

1. the attachment protocol is a DOM-free tested controller;
2. one semantic protocol and explicit transport encodings are enforced;
3. scrollback policy reaches runtimes through `TerminalService`;
4. the VT dependency contract and fork or no-fork decision are owned; and
5. registry membership and input authority each have one writer.

The preparatory register's persisted-scrollback-domain and dependency-branch
rows must be closed there with named approvers. This plan consumes those
decisions rather than duplicating them.

## Affected areas

- backend terminal actor, replay engine, service, types, commands, and tests;
- Tauri, instance control-socket, and CLI protocol adapters;
- the frontend attachment controller and ordered renderer-operation queue;
- `TerminalView`, viewport, visibility, theme, and renderer integration;
- terminal protocol, controller, visibility, queue, theme, and continuity
  tests; and
- durable operations tooling for the differential VT corpus.

## Work to be done

Implement these five changes in order:

1. [Visibility is presentation only](01-visibility-is-presentation-only.md).
2. [Resize is an ordered boundary](02-resize-is-an-ordered-boundary.md).
3. [Theme is an ordered palette change](03-theme-is-an-ordered-palette-change.md).
4. [Recovery is bounded and history-complete](04-recovery-is-bounded-and-history-complete.md).
5. [Prove convergence, cut over, and keep it closed](05-convergence-cutover-and-legacy-removal.md).

Visibility must stop controlling attachment lifetime before hidden resize and
palette behavior can be made correct. Resize introduces the ordered renderer
queue. Theme reuses it. Recovery is finalized after routine replay boundaries
are removed. Cutover then deletes superseded paths and installs the standing
gate.

## Decision register

Open rows block cutover. A row closes only with recorded evidence, the selected
contract, and named approvers; the role labels below do not substitute for
names.

- **Acceptable live VT divergence boundary — open.** Evidence: the differential
  corpus across supported workloads, including the known wrap-boundary cursor
  case. Approval: engineering and product.
- **Resize interaction contract — open.** Evidence: measured proposal-to-marker,
  drain, and renderer-apply behavior under idle output, sustained output, and
  drag. Approval: product.
- **Recovery snapshot byte budget — open.** Evidence: measurements of retained
  history, formatter output, raw frame size, queue pressure, and time to a
  correct screen for the supported scrollback policy. Approval: engineering
  and product.

## Acceptance criteria

- Resize, theme, and normal visibility changes produce no replay, reset, or
  attachment teardown.
- Every changed host geometry and semantic palette produces one correctly
  ordered marker, and xterm applies neither fact by another path.
- Hidden initialized terminals continue consuming the stream without avoidable
  DOM work and schedule at most one recovery after actual overflow.
- Each legitimate recovery installs the selected newest complete history
  suffix and complete active state atomically, with explicit loss causes.
- Production Tauri, control-socket, CLI, packaged macOS, and release-mode paths
  preserve the same protocol and continuity contract.
- Searches and structural checks find no legacy routine-replay path, direct
  host-fact assertion, or fallback byte codec.
- The durable VT gate continuously approves the controlled dual-parser
  architecture; a failed gate blocks release or activates the recorded
  escalation decision.

## How to validate

```sh
just test vt-divergence
just test fast
just test rust
just test full
just check all
just modularity boundaries
markdownlint docs/plans/top-5-closure/*.md
git diff --check
```

In addition to automated suites, validate a packaged macOS build with active
output while resizing, changing themes, hiding and revealing tabs, recreating
the renderer, forcing a sequence gap, and forcing bounded queue overflow.

## Exit and rollback

Exit only when every acceptance criterion is proven and every decision row is
closed. Replay on resize, theme, or ordinary visibility is not a rollback. If
the dual-parser gate fails, retain the evidence and execute the explicit
host-cell renderer escalation rather than weakening the contract.
