# Top five initial terminal changes

## Executive decision

These are the five initial enablers required before implementing the
[single-VT terminal closure](../top-5-single-vt-closure/README.md). They make the
current terminal capability safe to replace; they are not the replacement.

The end goal is one VT authority: Ghostty parses PTY output in the backend and
the frontend receives versioned semantic state, maintains a renderer-independent
client model, and paints cells without parsing PTY bytes or ANSI.

The root cause is the current double parse. Ghostty and xterm evolve terminal
state independently, so Shipctl uses reset plus ANSI replay to force apparent
convergence and lets routine presentation events become terminal
reconstruction. No ordering refinement can prove two emulators have identical
geometry, reflow, palette, cursor, modes, and history. The final closure removes
xterm as a parser rather than making the dual-parser path more elaborate.

## The five enablers

| # | Change | Closes |
| --- | --- | --- |
| 1 | [Ghostty semantic boundary is feasible and owned](01-ghostty-semantic-boundary-is-feasible-and-owned.md) | the sole-authority bet is untested |
| 2 | [Attachment protocol has a DOM-free test seam](02-attachment-protocol-has-a-dom-free-test-seam.md) | the protocol is untestable |
| 3 | [Retention policy has one service authority](03-retention-policy-has-one-service-authority.md) | the setting never reaches the host |
| 4 | [One semantic model has exhaustive adapters](04-one-semantic-model-has-exhaustive-adapters.md) | drift is undetected across languages |
| 5 | [Each terminal state has one writer](05-each-terminal-state-has-one-writer.md) | two writers race over one fact |

Why each is necessary before closure:

1. Without it, the plan commits to a sole VT authority whose required facts or
   operations may be unavailable.
2. Without it, sequencing and recovery cannot be tested independently, and the
   future client model inherits DOM assumptions.
3. Without it, the user policy never reaches the host that will own all history.
4. Without it, variant and required-field drift is undetected while the protocol
   expands to semantic state.
5. Without it, registry, close, attachment, and input races persist under a new
   transport and presentation.

Deleting any one leaves a direct closure prerequisite unproved. The earlier
proposals' raw-PTY binary cutover is deliberately absent: it would optimize the
input to the frontend parser that the final cutover deletes.

## Priority and dependencies

The file numbers express architectural priority, not a forced serial schedule.
The independent correctness work may proceed in parallel with two narrow gates:

```text
01A Ghostty feasibility
  ├── falsified ──> stop the closure; return evidence to the owner
  └── feasible ──┐
03 retention decision ─┴──> 01B dependency decision

02 attachment seam ───────────────> attachment-owned portion of 05
03 retention authority ───────────> independently shippable
04 contract completeness gate ────> independently shippable
05 single writers ────────────────> independently shippable by boundary

01B + 02 + 03 + 04 + 05 ─────────> single-VT closure work
```

Start the Ghostty falsification gate before target-shaped implementation work,
because it can stop the expensive closure. Its dependency decision also needs
the retention promise and measurements from change 03. Retention is the
highest-priority user-visible correction and does not wait for Ghostty semantic
feasibility. The attachment seam, contract gate, and non-overlapping state
writers are valid under any renderer architecture. Only the attachment-owned
part of change 05 waits for change 02.

If Ghostty feasibility is falsified, changes 02 through 05 remain valid
deliverables, but the single-VT closure stops for an owner architecture
decision.

## Scope boundary

This set does:

- prove and own the dependency boundary;
- extract the current attachment state machine without changing its behavior;
- connect normalized retention policy to every host runtime;
- install cross-language contract completeness checks; and
- establish one writer for each current terminal state.

This set does not:

- define or ship production semantic snapshots, deltas, history windows,
  effects, or semantic input;
- introduce the replacement cell surface or remove xterm;
- optimize Tauri PTY output/input, add a new codec, or alter CLI wire encoding;
- adopt ordered dual-parser resize or palette markers;
- change resize, theme, visibility, replay, or renderer behavior as part of the
  attachment extraction; or
- rewrite the two source proposal directories or other historical plans.

Those changes belong to the five areas in the single-VT closure plan.

## Owner decisions

These rows must be closed with evidence, a date, and a named approver. They are
the same decisions that govern the end state.

All three are closed. The decisions and their evidence are recorded in
`docs/ops/terminal-vt-dependency.md`, which is the durable page.

- **Retention promise — product, closed 2026-08-10 by Dariusz Debowczyk.** A
  byte-bounded contract backed by the measurements in
  `core/backend/src/terminal/retention.rs`. No owned complete-row operation.
- **Running retention updates — product, closed 2026-08-10 by Dariusz
  Debowczyk.** Construction-only. The pinned API has no retention setter, and
  rebuilding the parser to apply a setting is not an accepted branch.
- **Ghostty dependency branch — engineering, closed 2026-08-10 by Dariusz
  Debowczyk.** Pinned upstream. The OSC 9 payload goes upstream first; a
  binding-only local patch is carried only if the closure lands before that
  merges. No vendoring.

The retention promise is either exact configured rows backed by an owned
complete-row operation, or an honestly stated byte-bounded contract backed by
measurements. Running updates are either explicitly construction-only or use an
owned setter that preserves retained history. Reconstructing the parser to
apply a setting is not an accepted branch.

## Closure entry gate

Implementation of the single-VT transport and surface may begin only when:

- change 01 returns feasible and records the approved dependency branch;
- the DOM-free controller passes behavior-equivalent attachment traces;
- normalized retention reaches every new runtime under the approved product
  contract;
- Rust-to-wire-to-TypeScript variant and required-field drift fails the
  contract gate; and
- registry, attachment, close, module lifecycle, and input decisions have the
  single writers declared in change 05.

Completion of this set does not close the root cause. It proves that the
separate [single-VT closure](../top-5-single-vt-closure/README.md) can be
implemented without carrying today's hidden authorities into the new design.

## Common validation

Each change lists focused proof. The shared repository gates are:

```sh
just check all
just test fast
just test rust
just test full
just modularity boundaries
markdownlint docs/plans/top-5-initial-changes/*.md
git diff --check
```

New frontend terminal suites must be registered in the repository's terminal
test lane and run serially where they mutate shared terminal caches or runtime
singletons.
