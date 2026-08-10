# Terminal readiness — corrected top five

## Purpose

These five changes prepare Shipctl's terminal capability for the canonical
[single-VT closure plan](../top-5-single-vt-closure/README.md). They stabilize
the test seam, semantic protocol surface, retention policy, dependency
contract, and state ownership before the host-cell protocol and presentation
surface are implemented.

The team proposal supplied the better scope boundary: readiness work should not
quietly implement half of the selected architecture. The earlier
controlled-dual-parser target has since been superseded. Preparation must not
optimize raw PTY delivery to the frontend parser that the closure plan removes.

## The five changes

1. [Attachment protocol is testable](01-attachment-protocol-is-testable.md) —
   extract the attachment state machine from React without changing behavior.
2. [One semantic protocol, explicit adapters](02-one-protocol-explicit-encodings.md)
   — make Rust the semantic event authority and gate every adapter against
   drift without cutting production over to another raw-PTY encoding.
3. [Scrollback has one service authority](03-scrollback-service-authority.md) —
   connect canonical settings to `TerminalService` and runtime retention without
   allowing launch callers to inject policy.
4. [The VT dependency contract is owned](04-vt-dependency-contract-owned.md) —
   add compatibility and upgrade ownership now; vendor or fork only if the
   approved retention semantics require it.
5. [One writer per terminal state](05-one-writer-per-terminal-state.md) — make
   the registry reducer the descriptor-removal writer and separate attachment
   readiness from lifecycle write authority.

## Sequencing

```text
1 ───────────────> 5

2 ── semantic protocol coverage gate ───────┐
                                             ├─> single-VT closure plan
3 ── retention authority ───────────────────┘

3 measurements ──> 4 owner decision
```

- Change 1 is a pure extraction and precedes change 5's behavior corrections.
- Change 2 may begin independently. The semantic binary transport is change 2
  of the closure plan, after Ghostty's semantic contract is proven.
- Change 3 is independently shippable and should not wait for binary IPC.
- Change 4's compatibility fixture is independent. Any vendor/fork work follows
  the measured retention result and owner decision from change 3.
- The single-VT closure starts only after changes 1, 2, 3, and 5, plus the
  dependency proof portion of change 4. Its retention evidence closes change
  4's owner decision.

## Scope boundary

These readiness changes do not yet:

- remove replay from resize or theme;
- change attachment lifetime when a surface is hidden;
- define screen snapshots, deltas, history windows, or semantic input frames;
- implement semantic snapshot recovery;
- replace xterm with a host-cell renderer; or
- optimize raw PTY output or ANSI replay over Tauri.

Behavior changes in this set are limited to the explicitly proven defects:
host retention begins following canonical backend policy, and close/input
races receive consistent state ownership and typed outcomes.

Vendoring is not assumed to be essential. The no-fork path remains valid when
the product accepts byte-bounded physical retention and honest row-projection
semantics.

## Exit gate

Readiness is finished — and the full plan may start — when all five statements
are true at once:

1. The controller trace fixtures from change 1 are checked in and green, and
   `TerminalView` holds no protocol decision.
2. The drift gate from change 2 fails when a domain event variant is added
   without its Tauri, control-socket, and TypeScript adapters. The current raw
   wire forms are explicitly marked transitional rather than optimized.
3. Retention is measured, service-owned, and applied to every new runtime from
   canonical settings, with the persisted-value path and approved behavior for
   already-running terminals recorded.
4. The dependency branch in change 4 is decided and signed in the register
   below, and the compatibility fixtures gate updates.
5. One reducer owns descriptor membership, and write authority is typed and
   re-read after every await.

The resize-latency and reflow-divergence baselines from change 1 are also
recorded. They characterize the path being removed and keep the migration
evidence honest.

## Decision register

Three questions in this set are owner choices, not engineering findings. None
can be settled inside a document. Record the decision, its date, and the person
who approved it here, and link the evidence.

| Decision | Owner | Evidence | State |
| --- | --- | --- | --- |
| Scrollback row domain | product | change 3 | open |
| Running retention updates | product | change 3 and pinned API | open |
| Dependency branch | engineering | changes 3 and 4 | open |

- **Scrollback row domain** — are the current UI presets the exact persisted
  domain, or examples inside a wider supported range?
- **Running retention updates** — do changes apply only to later terminals, or
  does the owned dependency provide a live setter that preserves history?
- **Dependency branch** — pinned, vendored, or forked libghostty-vt.

An open row blocks the exit gate. A row closed without a named approver is not
closed; the project rule against invented limits applies to both.

## Common validation

Each change lists focused validation. The shared repository gates are:

```sh
just check all
just test fast
just test rust
just test full
markdownlint docs/plans/terminal-top-5-changes-sol/*.md
git diff --check
```

New frontend terminal suites must be registered in `ops/test/justfile` in the
same commit. Tests that mutate shared terminal caches or runtime singletons run
with `--test-concurrency=1`.
