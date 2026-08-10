# Prove convergence, cut over, and remove legacy paths

## Outcome

The ordered continuity architecture becomes Shipctl's only production path.
Automated, release-mode, and packaged-application evidence prove the end-state
contract, obsolete code and fallback codecs are removed, and durable documents
no longer mandate routine reset and replay.

## Context and purpose

The first four closure changes can coexist temporarily with old replay paths,
old contract text, and incomplete adapter coverage. That is not closure. A
future maintainer will restore the old behavior if the repository still calls
it authoritative or if it remains the easiest fallback.

This final change introduces no new terminal architecture. A failure returns
to its owning closure file. A material dual-parser convergence failure blocks
cutover and opens the already named host-cell renderer escalation; it does not
justify replay on routine resize.

## Dependencies

- Every preparatory exit criterion is met.
- Visibility, ordered resize, ordered palette, and bounded recovery are complete.
- The selected retention/dependency branch and owner-approved interaction and
  convergence contracts are recorded.

## Affected areas

- all `core/backend/src/terminal` production and test modules
- all `core/frontend/terminal` production and test modules
- `core/frontend/platform/tauri.ts`
- instance/control-socket protocol adapters and CLI terminal clients
- terminal settings integration and `TerminalService` construction
- `ops/test/justfile` and repository validation commands
- `research/20260809-124553-fut-tty/vt-proof`
- superseded terminal architecture and plan documents
- the packaged Tauri application

## Work to be done

1. Remove obsolete production paths and types:
   - resize/theme replay construction and replay-change bookkeeping;
   - visibility-driven attachment cleanup;
   - JSON numeric terminal byte arrays and conversion helpers;
   - attachment protocol state left in React;
   - descriptor membership writes outside the registry reducer;
   - lifecycle-derived attachment-readiness flags; and
   - compatibility flags or fallback codecs used only during migration.
2. Find every replay producer and `term.reset()` call. Keep only the four named
   recovery boundaries, each with a focused test naming why it is legitimate.
3. Exercise the production raw codec and controller through Tauri, the
   instance/control socket, and CLI consumers. Adding or dropping any semantic
   event must continue to fail the preparatory protocol-drift gate.
4. Add one end-to-end scenario that creates numbered history, anchors the
   viewport away from the bottom, and performs row resize, column resize, drag,
   visible and hidden theme changes, settings overlay, tab hide/show, hidden
   output, injected gap, recovery, renderer recreation, and close during stale
   reconciliation.
5. Assert protocol facts in that scenario:
   - zero routine replay, reset, or detach;
   - one marker per accepted changed geometry and palette revision;
   - one consecutive sequence across data and control events;
   - one snapshot per injected recovery boundary;
   - no missing or duplicate numbered output; and
   - no descriptor resurrection after observed removal.
6. Run alternate-screen, OSC 8, search, selection, copy, Unicode, application
   palette, bracketed paste, mouse mode, exit, and no-view-output behavior
   through the production codec and controller.
7. Run the differential Ghostty/xterm corpus over resize ordering, wrap-boundary
   cursor placement, active/alternate state, modes, palette, history, and every
   recovery boundary. Record the exact observed divergence and the product
   decision against the approved contract.
8. Repeat baseline measurements in release mode: raw output throughput and
   allocation, snapshot size and install time, resize-marker latency and drag
   behavior, hidden-pane work, and memory under the selected retention policy.
   Explain regressions against recorded constraints; do not invent a waiver.
9. Exercise terminal settings through production Tauri IPC across running,
   hidden, background, newly spawned, and later recovered terminals. Prove one
   canonical persisted policy revision reaches them all.
10. Perform a manual macOS pass with the packaged Tauri application, long
    history, an interactive shell, and a resize-aware full-screen program.
11. Update the earlier terminal plans and VT proof to describe one-authority,
    ordered dual-parser behavior, the true retention units, the exact recovery
    boundaries, bounded recovery, and the convergence/escalation decision.
    Mark superseded historical criteria rather than silently changing evidence.
12. Run the full repository, modularity, documentation, and worktree checks.
    Keep unrelated user changes outside the closure diff.

## Acceptance criteria

- The entire contract in [`end-state.md`](end-state.md) passes through the
  production Tauri adapter and packaged application, not only fake runtimes.
- Source search finds no resize, theme, or visibility path to replay, reset, or
  attachment teardown.
- Every remaining reset/snapshot call is mapped to one of the four legitimate
  recovery boundaries and has a focused test.
- Raw framing, total sequence order, registry ownership, input readiness, and
  canonical retention policy hold across every production adapter.
- The end-to-end scenario demonstrates preserved history, viewport, selection,
  content, cursor contract, palette, and lifecycle without loss or duplication.
- Release measurements and reproduction commands are checked in and satisfy
  the owner-approved constraints established before implementation.
- The packaged application passes resize, theme, visibility, recovery, full-
  screen, search, copy, link, paste, mouse, exit, and close-race behavior.
- Durable documentation describes the implementation that exists and names the
  accepted convergence boundary and escalation trigger.
- No compatibility feature flag, JSON/base64 Tauri byte fallback, or legacy
  routine-replay implementation remains after cutover.
- The dual-parser convergence gate is explicitly approved. If it is rejected,
  this cutover does not ship and replay is not restored as a workaround.

## How to validate

Inspect structural matches rather than requiring an empty search; the remaining
matches must map exactly to named recovery boundaries and their tests.

```sh
rg -n "TerminalEvent::Replay|term\.reset\(\)" \
  core/backend/src/terminal core/frontend/terminal
rg -n "Array\.from\(bytes\)|readonly number\[\]" \
  core/backend/src/terminal core/frontend/terminal core/frontend/platform

./research/20260809-124553-fut-tty/vt-proof/run.sh
just check all
just test full
just modularity boundaries
markdownlint docs/plans/top-5-closure-sol/*.md
git diff --check
git status --short
```

The manual packaged-app script must cover:

1. numbered history, middle-history scrolling, selection, and search;
2. height, width, and continuous drag resize;
3. visible and hidden theme changes plus child-authored colors and queries;
4. tab and settings visibility transitions while output continues;
5. first attachment, injected gap, overflow, and renderer recreation;
6. alternate-screen entry/exit, links, mouse, paste, and Unicode; and
7. close while a stale terminal-list reconciliation is delayed.

## Completion and escalation rule

Close the work only when isolated, production-adapter, release-mode, and
packaged-app evidence agree.

If the dual-parser convergence gate fails materially, preserve the ordered
protocol, retention, recovery, ownership, and test work. Stop this cutover and
open a separately authorized migration in which Ghostty supplies semantic
cells and a non-parsing renderer replaces xterm's VT authority. Do not widen a
special-case recovery path until it becomes replay-on-resize again.
