# Assistant terminal and lifecycle rails

Date: 2026-08-07

## Outcome

The host now exposes the capability-neutral terminal and lifecycle operations
needed to extract Assistant providers without teaching the host about Claude,
Codex, Pi, OpenCode, or Antigravity.

This is an enabling stage, not the Assistant cutover. Existing Assistant launch,
resume, identity-capture, and restore callers remain unchanged until their
module owns the complete workflow.

## Ownership boundary

The host continues to own infrastructure that is shared by every terminal-like
capability:

- native PTY creation, output, resize, focus, and termination;
- xterm instances and buffered rendering;
- generic tab identity, placement, and selection;
- dispatch of process-started and process-exited notifications.

A module owns capability policy and data:

- an opaque `ownerMetadata` value that core passes through without inspection;
- optional terminal or assistant presentation, including icon and status badge;
- reactions to requested rename, project placement, stop, and shutdown;
- provider-specific continuity state and resources.

## Transaction boundaries

Rename, placement, and stop are host-to-owner requests. Listeners are awaited in
subscription order. If an owner rejects a request, later listeners do not run
and the host does not perform the corresponding mutation.

Started and exited events are notifications. They are isolated from listener
failures because the process event has already occurred and cannot be rolled
back.

Modules may update a live generic session's label, opaque metadata, and
presentation through the terminal-session port. The host maps those changes to
its tab without importing module-specific provider types or assets.

`beforeShutdown` hooks run sequentially in module registration order before the
native shutdown command signals PTYs. A failed hook aborts shutdown, allowing a
module to refuse process termination when continuity data could not be safely
prepared.

## Compatibility boundary

Legacy Assistant tabs still use the existing `assistantId`, restore-record, and
capture-state fields. Module-owned sessions use `moduleSessionId` and generic
presentation. The next extraction stage moves Assistant frontend orchestration
and resources behind the new rail; only after that cutover can the temporary
Assistant-specific host branches be removed.

## Verification

The stage is protected by:

- terminal-session tests for update forwarding, opaque metadata, ordered owner
  requests, rejection short-circuiting, and stale binding cleanup;
- module-composition tests for ordered pre-shutdown execution and failure
  short-circuiting;
- Assistant characterization that asserts module preparation occurs before
  native preserving shutdown;
- the full frontend build and existing Commands, Skills, Git, global-surface,
  project-surface, and module-boundary suites;
- the full native test suite, even though this stage changes no Rust code.

## Rollback

This stage is one frontend-only commit. Reverting it restores the previous
terminal-session port and direct Assistant shutdown path without changing
native manifests or persisted user data.
