# Terminal continuity closure end state

## Decision

Keep xterm.js as Shipctl's terminal renderer and live VT mirror. Keep
libghostty-vt in the backend as the durable terminal and recovery authority.
Make the two parsers behave as one ordered system instead of using reset and
replay to reconcile every presentation change.

This is a controlled dual-parser architecture:

```text
PTY
  -> TerminalRuntime + libghostty-vt
       durable terminal state and retained history
  -> one sequenced attachment stream
       output + resize + palette + lifecycle + recovery
  -> TerminalAttachmentController
       ordering, readiness, generation, and recovery
  -> xterm.js
       disposable live mirror, rendering, links, search, and selection
```

Herdr's host-cell renderer is not the selected implementation. It is the
explicit escalation architecture if the dual-parser convergence gate fails.

## End goal

Shipctl presents one continuous terminal session across resize, theme changes,
tab switches, overlays, renderer replacement, sequence gaps, and subscriber
overflow.

Routine presentation changes preserve contents, retained history, cursor,
selection, modes, and viewport. Reset plus snapshot installation occurs only
when a renderer is new or its state can no longer be trusted.

The completed architecture has these properties:

1. The backend actor owns the PTY, Ghostty state, lifecycle, canonical geometry,
   semantic palette, retained history, sequence, and terminal incarnation.
2. The frontend attachment controller owns attachment generation, sequence
   validation, readiness, recovery coalescing, and ordered renderer delivery.
3. xterm owns rendering and its presentation-only policies. It does not decide
   canonical geometry, lifecycle, retention, or recovery boundaries.
4. Every data and control event for an incarnation participates in one total
   order. Resize and palette changes are barriers in that order.
5. Visibility is presentation state. Hiding an initialized terminal does not
   detach it, reset it, or stop consuming non-replaceable output.
6. Recovery snapshots contain a bounded, newest complete history suffix and
   the complete active terminal state. Missing history is reported rather than
   silently omitted.
7. Production Tauri byte streams use the versioned raw protocol established by
   the preparatory work. No terminal byte stream uses JSON numeric arrays.

## Root cause being closed

Two VT parsers are not inherently the defect. The defect is that Ghostty and
xterm currently evolve terminal state independently without one complete
contract for authority, event order, visibility, and recovery. Shipctl then
uses host replay followed by `term.reset()` as a general convergence mechanism.

That couples routine presentation changes to terminal reconstruction:

- resize becomes reset and replay;
- theme becomes reset and replay;
- hide/show becomes detach, attach, reset, and replay; and
- recovery content and ordering are asked to compensate for normal operation.

The misread `max_scrollback` byte budget explains the most visible history-loss
symptom. The preparatory retention work corrects that defect, but retention
alone does not close the architectural failure mode above.

## Exact recovery boundaries

Reset and snapshot installation are permitted only for:

1. initial attachment or first reveal of a never-attached renderer;
2. deliberate xterm-model recreation;
3. a detected sequence gap; and
4. bounded attachment-queue overflow.

Resize, theme change, normal hide/show, settings overlays, focus changes, and
ordinary descriptor updates are never recovery boundaries.

Each recovery installs one snapshot at sequence `N`. Live frames at or before
`N` are discarded, frames after `N` are held until snapshot installation
finishes, and delivery resumes at `N + 1` without duplication.

## Live convergence contract

Between recovery boundaries, Ghostty and xterm receive the same output and
ordered state transitions. xterm changes geometry only when it consumes the
host's sequenced resize marker, after all prior writes drain. It applies a
semantic palette only at the matching palette marker.

The known cursor-placement difference at a reflow-wrap boundary is acceptable
only if the checked-in differential corpus proves that it stays inside the
owner-approved product contract and converges at the defined boundary. A broad
or user-visible failure stops cutover. It must not be hidden behind replay on
selected or eventually most resizes.

## Prerequisite readiness work

These closure plans start after the exit gate in
[`terminal-top-5-changes-sol`](../terminal-top-5-changes-sol/README.md) is met:

1. the attachment protocol is a DOM-free tested controller;
2. one semantic protocol and explicit transport encodings are enforced;
3. scrollback policy reaches runtimes through `TerminalService`;
4. the VT dependency contract and fork/no-fork decision are owned; and
5. registry membership and input authority have one writer each.

The closure work does not repeat those changes. It consumes their types,
controller, raw codec, retention view, and ownership rules.

## The five closure changes

1. [Visibility is presentation only](01-visibility-is-presentation-only.md).
2. [Resize is an ordered boundary](02-resize-is-an-ordered-boundary.md).
3. [Theme is an ordered palette change](03-theme-is-an-ordered-palette-change.md).
4. [Recovery is bounded and history-complete](04-recovery-is-bounded-and-history-complete.md).
5. [Prove convergence, cut over, and remove legacy paths](05-convergence-cutover-and-legacy-removal.md).

The implementation order is intentional. Visibility must stop controlling the
attachment before hidden resize and palette behavior can be made correct.
Resize introduces the ordered renderer-operation queue. Theme reuses that
queue with different domain semantics. Recovery is finalized only after the
routine replay boundaries are gone. Cutover removes every superseded path.

## Completion contract

The terminal problem is closed only when all of the following are true:

- resize, theme, and normal visibility changes produce no replay, reset, or
  attachment teardown;
- every changed host geometry and semantic palette is represented by one
  correctly ordered marker;
- hidden terminals consume the stream without avoidable DOM work and recover
  at most once after actual overflow;
- every legitimate recovery boundary reconstructs the selected retained
  history and complete active state with explicit loss metadata;
- the production Tauri adapter, packaged macOS app, and release-mode workload
  pass the same continuity contract as isolated tests;
- source and contract searches find no legacy routine-replay path or fallback
  codec; and
- the VT convergence result is checked in and either approves this architecture
  or blocks cutover in favor of the explicitly owned cell-renderer escalation.

## Not separate closure changes

- Child `CSI 3 J` suppression is implemented only if a checked-in resize trace
  proves that exact supported defect.
- A Ghostty vendor or fork change follows the preparatory dependency decision;
  it is not inferred from this closure plan.
- A host-cell renderer is not developed in parallel. It begins only if the
  convergence gate rejects the chosen dual-parser architecture.
- New terminal features, renderer replacement for its own sake, and unrelated
  component cleanup do not petition to enter this plan.
