# Feedback round 2 — live reconciliation baseline

**Review status:** Round 1 accepted; the original reload-first plan remains
unschedulable. **Recorded:** 2026-08-08.

**Mission:** Let an agent change a TypeScript capability while Shipctl is
running without losing the terminal or assistant session performing the change.

## Bottom line

Make live reconciliation the first supported lifecycle. Do not put PTY
reattachment in front of it: removing planned webview reloads is the smaller and
more direct way to preserve the initiating mission. Reattachment remains useful
crash-recovery work, but it is not a substitute for a live module lifecycle.

The core design is a revision-driven module registry in Rust and a frontend
module supervisor. Every code version has an immutable, content-addressed URL.
The supervisor prepares a new module instance beside the old one, swaps one
immutable contribution snapshot, and lets the old instance drain resources it
already owns. A failed prepare or activation never displaces the active version.

## Round 1 dispositions

<!-- markdownlint-disable MD013 -->

| Finding | Disposition | Resolution |
| --- | --- | --- |
| Reload-first breaks the mission | Accepted, critical | Live reconciliation moves into v1; supported module operations never reload the webview. |
| Agent control plane is unplanned | Accepted, high | A local CLI and Tauri adapter call the same Rust registry and expose revision-based status. |
| Stable URLs do not prove new code | Accepted, high | Artifacts and import URLs include a content digest; update and rollback use different URLs. |
| Permission vocabulary is incomplete | Accepted, high | One capability catalog generates separate invoke, subscribe, channel, and host-service grants. |
| Thin core is not bounded | Accepted, high | The stable shell receives an explicit responsibility rule and capability inventory. |

<!-- markdownlint-enable MD013 -->

The detailed basis for these decisions is the complete
[round 1 review](../feedback-round-1/README.md).

## Response map

1. [Live reconciliation and agent control](01-live-reconciliation.md) defines
   desired versus observed state, immutable activation, rollback, and the
   shell-addressable control plane.
2. [Resource ownership and PTY continuity](02-resource-ownership-and-pty.md)
   defines instance scopes, leases, drain semantics, and the separate
   reattachment track.
3. [Capabilities, thin-core boundary, and proof](03-capabilities-core-and-proof.md)
   defines the permission vocabulary, current capability disposition, restart
   classification, and decisive end-to-end gate.

## Scheduling decision

The loader and manifest experiments in the parent plan remain useful. The
reload-based lifecycle in its README, target architecture, experiment order,
migration phase 4, and risk decisions must be rebaselined before implementation
is scheduled.

The revised plan is ready to schedule only when it makes these properties part
of v1:

- immutable module versions and transactional activation;
- a revision-driven runtime supervisor and atomic contribution snapshot;
- instance-scoped disposal, ownership, and resource draining;
- an agent-facing request, status, and diagnostic path;
- end-to-end proof that the originating terminal remains interactive.
