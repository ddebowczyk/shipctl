# Prove convergence, cut over, and keep it closed

## Outcome

The ordered continuity architecture becomes Shipctl's only production path.
Automated, release-mode, and packaged-application evidence prove the end-state
contract; obsolete code and fallback codecs are removed; durable documents no
longer mandate routine reset and replay; and the convergence corpus becomes a
standing gate rather than a one-time approval.

## Context and purpose

The first four closure changes can coexist temporarily with old replay paths,
old contract text, and incomplete adapter coverage. That is not closure. A
future maintainer will restore the old behavior if the repository still calls
it authoritative or if it remains the easiest fallback.

This change introduces no new terminal architecture. A failure returns to its
owning closure file. A material dual-parser convergence failure blocks cutover
and opens the already named host-cell renderer escalation; it does not justify
replay on routine resize.

It carries one obligation the other four do not. Cutover proves the two parsers
agree **today**. Nothing in that proof stops them from drifting apart tomorrow:
libghostty-vt is pinned to a third-party commit
(`core/backend/Cargo.toml:23`) and xterm.js updates on its own schedule. Either
side can move and nothing would notice. A plan that closes the problem without
keeping it closed returns the same class of defect from a different direction.
So the differential corpus is promoted from a research artifact into durable
tooling that runs on every change, and the authority split is enforced by
removing APIs rather than by documenting rules.

## Dependencies

- Every preparatory exit criterion is met.
- Visibility, ordered resize, ordered palette, and bounded recovery are
  complete.
- The selected retention and dependency branch, and the owner-approved
  interaction and convergence contracts, are recorded in the decision register
  in [`end-state.md`](end-state.md).

## Affected areas

- all `core/backend/src/terminal` production and test modules
- all `core/frontend/terminal` production and test modules
- `core/frontend/platform/tauri.ts`
- instance and control-socket protocol adapters, and CLI terminal clients
- terminal settings integration and `TerminalService` construction
- `core/frontend/terminal/terminalSessions.ts`
- `modules/api/frontend/src/services.ts`
- `modules/commands/frontend/src/runtime.ts`
- `modules/assistants/frontend/src/runtime.ts`
- `ops/test/justfile` and repository validation commands
- `research/20260809-124553-fut-tty/vt-proof`, and its durable successor
- `docs/ops/`
- superseded terminal architecture and plan documents
- the packaged Tauri application

## Work to be done

Items 1 to 3 remove the old path. Items 4 to 11 prove the whole contract.
Items 12 to 18 keep it closed. Items 19 and 20 leave the record true.

1. Remove obsolete production paths and types:
   - resize and theme replay construction, and replay-change bookkeeping;
   - visibility-driven attachment cleanup;
   - JSON numeric terminal byte arrays and conversion helpers;
   - attachment protocol state left in React;
   - descriptor membership writes outside the registry reducer;
   - lifecycle-derived attachment-readiness flags; and
   - compatibility flags or fallback codecs used only during migration.
2. Find every replay producer and `term.reset()` call. Keep only the four named
   recovery boundaries, each with a focused test naming why it is legitimate.
3. Enforce the authority split by deletion, with one exact limit. Remove every
   request, acknowledgement, visibility catch-up, and direct-store API that
   lets the renderer assert a host-owned fact *independently*. Keep the
   renderer mutation APIs, because xterm must still apply the host fact — but
   only behind the ordered operation queue, driven by the matching marker. A
   rule that survives only as prose decays; removing the independent path is
   the enforcement, and a comment is not.
4. Exercise the production raw codec and controller through Tauri, the instance
   and control socket, and CLI consumers. Adding or dropping any semantic event
   must continue to fail the preparatory protocol-drift gate.
5. Add one end-to-end scenario that creates numbered history, anchors the
   viewport away from the bottom, and performs row resize, column resize, drag,
   visible and hidden theme changes, settings overlay, tab hide and show,
   hidden output, injected gap, recovery, renderer recreation, and close during
   stale reconciliation.
6. Assert protocol facts in that scenario:
   - zero routine replay, reset, or detach;
   - one marker per accepted changed geometry and palette revision;
   - one consecutive sequence across data and control events;
   - one snapshot per injected recovery boundary;
   - no missing or duplicate numbered output; and
   - no descriptor resurrection after observed removal.
7. Run alternate-screen, OSC 8 links, selection, copy, Unicode, application
   palette, bracketed paste, mouse mode, exit, and no-view-output behavior
   through the production codec and controller. The installed addons are
   `addon-fit`, `addon-unicode11`, `addon-web-links`, and `addon-webgl`; there
   is no search addon in `package.json` or in any import. Do not test search
   as an existing capability. If the escalation inventory in
   [`end-state.md`](end-state.md) confirms search as a product requirement,
   it enters as new work with its own plan, not as a cutover check.
8. Confirm the module contract as broad final regression coverage for the
   preparatory registry and close single-writer work, which moved
   `publishTerminalClosed` into the reducer. Verify that registry lifecycle
   still reaches module subscribers exactly once, and that attachment
   visibility emits no lifecycle event at all. Run both characterization
   suites unmodified, or record a deliberate contract change with the module
   owner. Attachment lifetime is not a module-visible fact; see change 01.
9. Repeat baseline measurements in release mode: raw output throughput and
   allocation, snapshot size and install time, resize-marker latency and drag
   behavior, hidden-pane work, and memory under the selected retention policy.
   Compare against the preparatory baselines using the recorded method.
   Explain regressions against recorded constraints; do not invent a waiver.
10. Exercise terminal settings through production Tauri IPC across running,
    hidden, background, newly spawned, and later recovered terminals. Prove one
    canonical persisted policy revision reaches them all.
11. Perform a manual macOS pass with the packaged Tauri application, long
    history, an interactive shell, and a resize-aware full-screen program.
12. Promote the differential corpus out of `research/`. Dated working notes
    stay there; a merge gate is durable tooling and belongs with the ops
    capability that runs it. This follows the repository documentation policy:
    durable reference in `docs/`, dated evidence in `research/`, and procedure
    prose in `ops/<capability>/skills/` once that capability exists.
13. Build the corpus from the full measured divergence surface, not the single
    known case: reflow at wrap boundaries, alternate-screen entry and exit,
    cursor save and restore, wide characters, combining marks, mode changes,
    and colors.
14. Assert only against the authority boundary the end state defines. A fixture
    that asserts agreement on a fact one side no longer owns is noise, will be
    silenced, and defeats the gate.
15. Record every accepted divergence with its case, its reason, and its
    approver, in the decision register. An accepted divergence is a decision;
    an unrecorded one is a defect waiting.
16. Register the gate in `ops/test/justfile` beside the consolidated terminal
    suites, and make it run on the same trigger as the preparatory
    libghostty-vt compatibility fixtures. A parser bump that passes one and
    fails the other must not merge.
17. Prove the gate works by breaking it on purpose. Perturb one parser's
    handling of a covered case, confirm the gate fails and names that case,
    then revert. A gate never observed failing has not been shown to work.
18. Document the procedure under `docs/ops/`: how to run it, how to read a
    failure, how to accept a new divergence, and who approves that.
19. Update the earlier terminal plans and the VT proof to describe
    one-authority, ordered dual-parser behavior, the true retention units, the
    exact recovery boundaries, bounded recovery, and the convergence and
    escalation decision. Mark superseded historical criteria rather than
    silently changing evidence.
20. Run the full repository, modularity, documentation, and worktree checks.
    Keep unrelated user changes outside the closure diff.

## Acceptance criteria

- The entire contract in [`end-state.md`](end-state.md) passes through the
  production Tauri adapter and packaged application, not only fake runtimes.
- Source search finds no resize, theme, or visibility path to replay, reset, or
  attachment teardown.
- Every remaining reset and snapshot call maps to one of the four legitimate
  recovery boundaries and has a focused test.
- No API lets the renderer assert a host-owned fact independently. Renderer
  mutation survives only behind the ordered operation queue, driven by the
  matching host marker. This is proved by absence from the diff, not by a
  comment.
- Raw framing, total sequence order, registry ownership, input readiness, and
  canonical retention policy hold across every production adapter.
- The end-to-end scenario shows preserved history, viewport, selection,
  content, cursor contract, palette, and lifecycle without loss or duplication.
- Registry lifecycle reaches module subscribers exactly once after the
  preparatory close and reconciliation ownership change, and no attachment
  visibility transition emits a lifecycle event. The commands and assistants
  characterization suites pass unmodified, or a deliberate module contract
  change is recorded with its owner.
- Release measurements and reproduction commands are checked in and satisfy the
  owner-approved constraints established before implementation.
- The packaged application passes resize, theme, visibility, recovery,
  full-screen, copy, link, paste, mouse, exit, and close-race behavior.
- The convergence corpus runs from `just`, lives outside `research/`, covers
  every case in the measured divergence surface, and gates dependency updates
  together with the preparatory compatibility fixtures.
- The gate has been observed failing on a deliberate perturbation and naming
  the diverging case. Its failure output shows both screens; a red result that
  requires re-deriving the cause by hand is not finished work.
- The gate does not fail on facts outside the authority boundary. A false
  positive is treated as a defect in the gate.
- Accepted divergences appear in the decision register with reason and
  approver.
- Durable documentation describes the implementation that exists and names the
  accepted convergence boundary and the escalation trigger.
- No compatibility feature flag, JSON or base64 Tauri byte fallback, or legacy
  routine-replay implementation remains after cutover.
- The dual-parser convergence gate is explicitly approved. If it is rejected,
  this cutover does not ship and replay is not restored as a workaround.

## How to validate

Inspect structural matches rather than requiring an empty search; the remaining
matches must map exactly to named recovery boundaries and their tests.

The third search is the mechanical form of the authority table in
[`end-state.md`](end-state.md). Every surviving `term.resize`,
`options.theme`, and `fitAddon.fit` call must sit inside the ordered
renderer-operation queue or a named recovery boundary. A call reachable from a
request, acknowledgement, visibility, or store path is a host-owned fact
asserted independently, and it fails the gate. `proposeDimensions()` is not on
this list: proposing geometry is a renderer act, applying it is not.

```sh
rg -n "TerminalEvent::Replay|term\.reset\(\)" \
  core/backend/src/terminal core/frontend/terminal
rg -n "Array\.from\(bytes\)|readonly number\[\]" \
  core/backend/src/terminal core/frontend/terminal core/frontend/platform

rg -n "\.resize\(|options\.theme|fitAddon\.fit\(" \
  core/frontend/terminal

just test vt-divergence
pnpm exec node --test --test-concurrency=1 \
  modules/commands/frontend/tests/commandsCharacterization.test.ts \
  modules/assistants/frontend/tests/assistantsCharacterization.test.ts
just check all
just test full
just modularity boundaries
markdownlint docs/plans/top-5-closure/*.md
git diff --check
git status --short
```

The manual packaged-app script must cover:

1. numbered history, middle-history scrolling, and selection;
2. height, width, and continuous drag resize;
3. visible and hidden theme changes, plus child-authored colors and queries;
4. tab and settings visibility transitions while output continues;
5. first attachment, injected gap, overflow, and renderer recreation;
6. alternate-screen entry and exit, links, mouse, paste, and Unicode; and
7. close while a stale terminal-list reconciliation is delayed.

## Exit and rollback

Close the work only when isolated, production-adapter, release-mode, and
packaged-app evidence agree, and the standing gate is green and proved to fail
on a real divergence.

If the dual-parser convergence gate fails materially, preserve the ordered
protocol, retention, recovery, ownership, and test work. Stop this cutover and
open a separately authorized migration in which Ghostty supplies semantic cells
and a non-parsing renderer replaces xterm's VT authority. Do not widen a
special-case recovery path until it becomes replay-on-resize again.
