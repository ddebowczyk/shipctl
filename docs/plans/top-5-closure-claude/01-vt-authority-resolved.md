# Resolve the VT authority

## Outcome

Decide and record which parser owns the screen. Give the host and xterm.js
disjoint responsibilities, so that no screen fact has two owners and no
disagreement between them is possible by construction.

## Context and purpose

Shipctl runs libghostty-vt in the host and xterm.js in the view. Both parse the
same PTY bytes and both build a screen. The `vt-proof` harness in
`research/20260809-124553-fut-tty/vt-proof` measures where they disagree: cursor
placement at a reflow wrap boundary.

The current cure is to make the host canonical and force agreement with reset
plus replay. That works, and it is why replay sits on the resize path
(`core/backend/src/terminal/runtime.rs:679`). Remove the disagreement and the
reason for routine-path replay goes with it.

fut and cmux both avoid this by design: each has exactly one VT authority and
ships rendered state to its views. Shipctl keeps xterm deliberately, for addons,
links, search, and the GPU renderer. The trade is defensible. Keeping the trade
without deciding which parser is authoritative is not.

This change produces a recorded decision and the code that enforces it. It does
not produce a rewrite.

## The branches

Each branch must be evaluated against the same evidence, not chosen by taste.

**A — host is a byte pipe; xterm owns the screen.** The host keeps the PTY, the
sequence stream, and a scrollback byte store, and stops asserting screen
content. libghostty-vt narrows to retention and snapshot production. Reflow
belongs to xterm alone, so the divergence cannot be observed.

- Cheapest to reach from the current code.
- Recovery snapshots become byte suffixes, which suits change 3.
- The host loses the ability to answer questions about the screen. Any current
  or planned host feature that reads screen state must be listed and re-homed.

**B — host owns the screen; xterm renders cells.** The host ships cells, as fut
does with `ScreenSnapshot { cells }`. xterm becomes a renderer driven by host
state rather than a parser.

- Removes the divergence completely and gives the host full screen knowledge.
- Costs the most: the xterm addons, link handling, and search that justify
  keeping xterm all assume xterm parsed the bytes. Each must be re-homed or
  lost.

**C — split by screen, with a stated boundary.** For example, the host owns
retention and the alternate screen while xterm owns the primary screen and its
reflow.

- Only admissible if the boundary is exact and testable. A split that cannot be
  stated as a rule is branch A with extra steps.

## Affected areas

- `core/backend/src/terminal/replay.rs`
- `core/backend/src/terminal/runtime.rs`
- `core/backend/src/terminal/types.rs`
- `core/frontend/terminal/TerminalView.tsx`
- `core/frontend/terminal/terminalAttachmentController.ts`
- `research/20260809-124553-fut-tty/vt-proof`
- `docs/plans/top-5-closure-claude/end-state.md` decision register

## Work to be done

1. Enumerate every consumer of host screen state today. Search
   `replay.rs`, `runtime.rs`, the instance control protocol, and the CLI for
   reads that assume the host knows the screen. Branch A is only viable if every
   entry on this list has a home.
2. Enumerate every xterm capability the product depends on: addons, link
   detection, search, selection, and the GPU renderer. Branch B is only viable
   if every entry has a home.
3. Extend the `vt-proof` harness to measure the divergence surface, not one
   case. Cover reflow at wrap boundaries, alternate-screen entry and exit,
   cursor save and restore, wide characters, combining marks, and mode changes.
   Record which cases diverge and by how much.
4. Take the decision with the named owners in the register. State the branch,
   the responsibilities each side keeps, and the capabilities being given up.
5. Enforce the decision in code. The losing side must be unable to assert the
   fact it no longer owns — remove the API, do not document the rule.
6. Record the consequences for changes 2, 3, and 5 in their documents before
   those changes begin.

## Acceptance criteria

- The register row is closed with a branch, a date, and a named approver.
- Each screen fact has exactly one owner, and the document states which.
- The non-owning side has no code path that can produce the fact it lost. This
  is proved by absence of the API, not by a comment.
- The divergence surface is measured across all listed cases and checked in,
  not summarized from one known example.
- Every host screen-state consumer and every depended-on xterm capability
  appears in the enumeration with a stated outcome: kept, moved, or dropped.
- A dropped capability is named in the decision. Silent loss is a defect.
- Change 5 is either scheduled or recorded as not applicable, with the reason.

## How to validate

```sh
./research/20260809-124553-fut-tty/vt-proof/run.sh
cargo test --manifest-path core/backend/Cargo.toml terminal::replay
cargo test --manifest-path core/backend/Cargo.toml terminal::runtime
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts
just check all
just test rust
git diff --check
```

The decision is not validated by tests. It is validated by the register row and
by the absence of the removed API. Confirm both by inspection of the diff.
