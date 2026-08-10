# Cut over to one VT, remove the duplicate parser, and keep it closed

## Outcome

The single-authority architecture becomes Shipctl's only production path. xterm,
the ANSI replay formatter, and every path that carried PTY bytes to the frontend
are deleted. Automated, release-mode, and packaged-application evidence prove
the end-state contract, and a conformance corpus keeps the host semantic model
and the presentation model in agreement as the dependency moves.

## Context and purpose

The first four changes can coexist temporarily with xterm, with the ANSI replay
path, and with old contract text. That is not closure. A future maintainer will
restore the old behavior if the repository still calls it authoritative or if it
remains the easiest fallback.

This change introduces no new terminal architecture. A failure returns to its
owning change.

It carries one obligation the others do not. Cutover proves the implementation
is correct **today**. Nothing in that proof stops the host semantic model and
the presentation model from drifting apart tomorrow: libghostty-vt is pinned to
a third-party commit (`core/backend/Cargo.toml:23`) whose own Ghostty pin moves
with it, and the presentation surface changes on our schedule. Either side can
move and nothing would notice.

The superseded plan answered this with a Ghostty-versus-xterm convergence gate.
That gate cannot survive, because after cutover there is no second parser to
converge with — and keeping one alive as a permanent oracle would reintroduce
the thing this plan removes. The replacement is a conformance corpus: fixed PTY
input produces a fixed semantic model, and a fixed semantic model produces fixed
presentation facts. It gates dependency updates alongside the preparatory
libghostty-vt compatibility fixtures.

## Dependencies

- The preparatory criteria this plan retains are met: the DOM-free attachment
  seam, retention authority, dependency ownership, the exhaustive
  protocol-mapping principle, and the single-writer state work. The preparatory
  production raw-PTY Tauri output and input cutover is superseded by change 02
  and is not a prerequisite.
- Changes 01 to 04 are complete, and change 04's inventory is fully classified.
- The decision register in [`end-state.md`](end-state.md) has no open row,
  including retention and the dependency branch.

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
- `package.json` and the pnpm lockfile
- `ops/test/justfile` and repository validation commands
- `research/20260809-124553-fut-tty/vt-proof`, and its durable successor
- `docs/ops/`
- superseded terminal architecture and plan documents
- the packaged Tauri application

## Work to be done

Items 1 to 5 remove the old path. Items 6 to 13 prove the whole contract. Items
14 to 19 keep it closed. Items 20 and 21 leave the record true.

1. Route every terminal through semantic frames. Remove the migration switch and
   the legacy path together, in one change, so no build ships both.
2. Remove xterm and its addons from `package.json` and the lockfile:
   `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-unicode11`,
   `@xterm/addon-web-links`, and `@xterm/addon-webgl`. The parity oracle harness
   from change 04 goes with them; it was migration evidence, not a dependency.
3. Remove the ANSI replay formatter and its supporting production paths:
   `format_active_screen`, cursor-cell and wrap-continuation emission, hyperlink
   re-emission, and style-sequence construction in
   `core/backend/src/terminal/replay.rs`. The state traversal these paths
   perform survives in semantic snapshot production; only the re-encoding dies.
4. Remove every path that transports child PTY bytes or host-formatted replay
   ANSI across a Shipctl boundary, including JSON numeric byte arrays and their
   conversion helpers, and any compatibility codec used only during migration.
   This includes the CLI. Cut `shipctl terminals attach` over to the semantic
   presentation adapter that change 02 prototypes and measures: it consumes
   semantic frames and paints authoritative cells to the caller's external
   terminal.

   The distinction is transport versus local presentation. The CLI may emit
   presentation control sequences it generates locally from semantic frames, and
   the external terminal interprets them. Those sequences are not a transported
   VT authority: the CLI never reparses the child PTY stream, and no Shipctl
   adapter carries child bytes or replay ANSI. `write_raw_replay`
   (`cli/src/terminals.rs:319-328`) and the `args.raw` output branches at
   `:257`, `:265-266`, and `:286-287` are deleted with the rest.

   Characterize interactive scrollback, cursor, alternate screen, resize,
   signals and job control, raw presentation output, and NDJSON output before
   the cut. If the compatibility contract cannot be met, stop change 05 and
   return the falsifying evidence to the owner. The owner decision or the
   architecture is revised before the work continues. There is no exception
   branch: the CLI semantic adapter is part of the end state, and single-VT
   closure cannot be claimed through a decision-register waiver while a Shipctl
   adapter still transports PTY bytes or replay ANSI.
5. Remove attachment protocol state left in React, descriptor membership writes
   outside the registry reducer, and lifecycle-derived attachment-readiness
   flags.
6. Exercise the production frame codec and controller through Tauri, the
   instance and control socket, and CLI consumers. Adding or dropping any
   semantic event or frame field must continue to fail the preparatory
   protocol-drift gate.
7. Add end-to-end coverage that creates numbered history, anchors the
   viewport away from the bottom, and performs row resize, column resize, drag,
   visible and hidden theme changes, settings overlay, tab hide and show, hidden
   output, injected gap, recovery, surface recreation, history-window browsing,
   and close during stale reconciliation.
8. Assert protocol facts in that coverage:
   - zero terminal reconstruction on resize, theme change, or visibility;
   - one consecutive sequence across frames and side effects;
   - one unbased snapshot per injected recovery boundary, and none from resize
     or surface recreation;
   - every frame applied against its declared base revision;
   - no missing or duplicate numbered output; and
   - no descriptor resurrection after observed removal.
9. Run alternate-screen entry and exit, OSC 8 links, plain-text links,
   selection, copy, paste, Unicode graphemes and wide cells, application
   palette, mouse modes, IME composition, bell, OSC 9 notification, title, exit,
   and no-surface-output behavior through the production codec and surface.
10. Confirm the module contract as broad final regression coverage for the
    preparatory registry and close single-writer work, which moved
    `publishTerminalClosed` into the reducer. Verify that registry lifecycle
    still reaches module subscribers exactly once, and that attachment
    visibility emits no lifecycle event at all. Run both characterization suites
    unmodified, or record a deliberate contract change with the module owner.
11. Repeat baseline measurements in release mode: frame throughput and
    allocation, snapshot size and install time, delta size distribution, resize
    latency and drag behavior, hidden-pane work, cache-missing history-window
    latency, and memory under the selected retention policy. Compare against the
    preparatory baselines using the recorded method. Explain regressions against
    recorded constraints; do not invent a waiver.
12. Exercise terminal settings through production Tauri IPC across running,
    hidden, background, newly spawned, and later recovered terminals. Prove one
    canonical persisted policy revision, and prove the **approved** retention
    applicability separately for newly created and for already-running
    terminals. If the closed register row selected the construction-only branch,
    prove the disclosure area 01 requires rather than an update that the pinned
    API cannot perform.
13. Perform a manual macOS pass with the packaged Tauri application, long
    history, an interactive shell, a resize-aware full-screen program, a
    non-Latin input method, and both transparent and opaque themes.
14. Build the conformance corpus in two halves: fixed PTY input to a fixed
    semantic model, and a fixed semantic model to fixed presentation facts.
    Neither half may be asserted against the other's implementation.
15. Cover the full measured divergence surface in the first half: reflow at wrap
    boundaries, alternate-screen entry and exit, cursor save and restore, wide
    characters, combining marks, mode changes, colors, and scrollback eviction.
16. Promote the corpus out of `research/`. Dated working notes stay there; a
    merge gate is durable tooling and belongs with the ops capability that runs
    it. This follows the repository documentation policy: durable reference in
    `docs/`, dated evidence in `research/`, and procedure prose in
    `ops/<capability>/skills/` once that capability exists.
17. Register the gate in `ops/test/justfile` beside the consolidated terminal
    suites, and make it run on the same trigger as the preparatory libghostty-vt
    compatibility fixtures. A dependency bump that passes one and fails the other
    must not merge.
18. Prove the gate works by breaking it on purpose. Perturb one covered case in
    the semantic extractor and again in the presentation model, confirm the gate
    fails and names the case each time, then revert. A gate never observed
    failing has not been shown to work.
19. Document the procedure under `docs/ops/`: how to run it, how to read a
    failure, how to accept a new conformance change, and who approves that.
20. Update the earlier terminal plans and the VT proof to describe
    single-authority behavior, the true retention units and the effective
    retention floor, the four recovery boundaries, host-owned history windows,
    and the parity inventory outcome. Mark superseded historical criteria rather
    than silently changing evidence.
21. Run the full repository, modularity, documentation, and worktree checks. Keep
    unrelated user changes outside the closure diff.

## Acceptance criteria

- The entire contract in [`end-state.md`](end-state.md) passes through the
  production Tauri adapter and packaged application, not only fake runtimes.
- No VT parser exists in the frontend. `@xterm` appears in no source file, no
  `package.json`, and no lockfile entry.
- No ANSI replay formatter remains in the backend, and no child PTY byte or
  host-formatted replay ANSI crosses a Shipctl transport boundary in any
  adapter — webview, control socket, or CLI. No exception survives; a
  compatibility contract that cannot be met stops the change instead.
- Presentation control sequences the CLI generates locally from semantic frames
  are not a transport payload and are not covered by that prohibition.
- Source search finds no resize, theme, or visibility path to terminal
  reconstruction or attachment teardown.
- Every remaining **unbased** snapshot installation maps to one of the four
  recovery boundaries in
  [change 03](03-attachment-model-is-renderer-independent.md) and has a focused
  test. A complete grid delivered on a valid base revision, such as the frame a
  resize produces, is an ordinary transition and is not counted here.
- No migration switch, compatibility feature flag, raw PTY or ANSI fallback, or
  legacy path remains. This is proved by absence from the diff, not by a
  comment. The fallback stays behind exactly one switch until this change, never
  receives new features, and is removed here. The prohibition is on raw PTY and
  ANSI, not on encoding: the control socket may base64-encode the selected
  semantic binary payload inside its adapter, under change 02's transport
  contract.
- Frame versioning, total sequence order, registry ownership, input readiness,
  and canonical retention policy hold across every production adapter.
- The end-to-end coverage shows preserved history, viewport, selection, content,
  cursor contract, palette, and lifecycle without loss or duplication.
- Registry lifecycle reaches module subscribers exactly once after the
  preparatory close and reconciliation ownership change, and no attachment
  visibility transition emits a lifecycle event. The commands and assistants
  characterization suites pass unmodified, or a deliberate module contract change
  is recorded with its owner.
- Release measurements and reproduction commands are checked in and satisfy the
  owner-approved constraints established before implementation.
- The packaged application passes resize, theme, visibility, recovery,
  full-screen, copy, link, paste, mouse, IME, exit, and close-race behavior.
- The conformance corpus runs from `just`, lives outside `research/`, covers
  every case in the measured divergence surface, and gates dependency updates
  together with the preparatory compatibility fixtures.
- The gate has been observed failing on a deliberate perturbation in each half
  and naming the affected case. Its failure output shows the expected and actual
  state; a red result that requires re-deriving the cause by hand is not
  finished work.
- Accepted conformance changes appear in the decision register with reason and
  approver.
- Durable documentation describes the implementation that exists and names the
  retention policy, the recovery boundaries, and the parity inventory outcome.

## How to validate

Inspect structural matches rather than requiring an empty search where a match
is legitimate; the remaining matches must map exactly to named recovery
boundaries and their tests.

```sh
rg -n "@xterm" core/frontend modules src package.json pnpm-lock.yaml
rg -n "format_active_screen|TerminalEvent::Replay" core/backend/src/terminal
rg -n "Array\.from\(bytes\)|readonly number\[\]" \
  core/backend/src/terminal core/frontend/terminal core/frontend/platform
rg -n "write_raw_replay|data_base64" cli/src core/backend/src/instance

just test vt-conformance
pnpm exec node --test --test-concurrency=1 \
  modules/commands/frontend/tests/commandsCharacterization.test.ts \
  modules/assistants/frontend/tests/assistantsCharacterization.test.ts
just check all
just test full
just modularity boundaries
markdownlint docs/plans/top-5-single-vt-closure/*.md
git diff --check
git status --short
```

The first three searches must return nothing. Each was a load-bearing path
before this change, and each returning empty is the mechanical proof that the
duplicate parser and its transport are gone. The fourth covers the last raw
consumer: `data_base64` may survive only where change 02's control-socket
adapter encodes a semantic payload, and `write_raw_replay` must be gone.

The manual packaged-app script must cover:

1. numbered history, middle-history scrolling, and selection;
2. height, width, and continuous drag resize;
3. visible and hidden theme changes, plus child-authored colors and queries;
4. tab and settings visibility transitions while output continues;
5. first attachment, injected gap, overflow, and surface recreation;
6. alternate-screen entry and exit, links, mouse, paste, IME, and Unicode;
7. transparent and opaque themes, and accelerated-renderer failure fallback; and
8. close while a stale terminal-list reconciliation is delayed.

## Exit and rollback

Close the work only when isolated, production-adapter, release-mode, and
packaged-app evidence agree, and the conformance gate is green and proved to
fail on a real perturbation.

If cutover fails materially, preserve the semantic contract, transport,
attachment model, retention, and test work, and keep the legacy path until the
specific failure is fixed. Do not respond by widening a special-case recovery
path until it becomes reconstruction-on-resize again, and do not restore a
frontend parser as a permanent authority.
