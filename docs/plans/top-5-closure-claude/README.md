# Terminal closure — the five changes that end the problem

Start with [end-state.md](end-state.md). It states the goal, the root cause, the
sequencing, and what done means. The rest of this file is an index.

The readiness set in `docs/plans/terminal-top-5-changes-sol/` makes the terminal
capability safe to change. This set is the change.

## Index

| # | Change | Closes |
| --- | --- | --- |
| 0 | [End state](end-state.md) | goal, cause, sequencing |
| 1 | [Resolve the VT authority](01-vt-authority-resolved.md) | the root cause |
| 2 | [Ordered state events](02-ordered-state-events.md) | the felt symptom |
| 3 | [Bounded recovery](03-bounded-recovery.md) | recovery cost |
| 4 | [Attachment follows the terminal](04-attachment-follows-terminal.md) | tab-switch recovery |
| 5 | [Divergence gate](05-divergence-gate.md) | decay of change 1 |

## In one paragraph

The protocol can express bytes but not state changes, so a geometry or palette
change can only be applied by discarding everything and sending it again. That
gap exists because two VT parsers own one screen and disagree at a reflow wrap
boundary, and reset plus replay is the workaround for the disagreement. Change 1
removes the disagreement. Change 2 gives the protocol the missing expression and
deletes the routine-path replay. Changes 3 and 4 remove the remaining reasons
recovery runs when nothing failed. Change 5 keeps change 1 true.

## Before starting

Three register rows must be closed:

- the persisted scrollback domain and the libghostty-vt dependency branch, in
  `docs/plans/terminal-top-5-changes-sol/README.md`;
- the VT authority split, in [end-state.md](end-state.md).

The readiness exit gate in that same README must also be green.

## Common validation

```sh
just check all
just test fast
just test rust
just test full
markdownlint docs/plans/top-5-closure-claude/*.md
git diff --check
```
