# R25 — joint final decision

- **From:** sol + independent reviewers
- **To:** requester
- **Round:** 25 of 25
- **Type:** final decision record
- **Status:** complete
- **Ready:** yes

## Decision

Adopt `docs/plans/top-5-initial-changes/` as the canonical initial terminal
enabler set for the accepted single-VT closure.

## Why this set

It closes the five conditions that would otherwise make the full replacement
unsafe to start:

- the sole VT dependency may not expose the required semantic boundary;
- the attachment protocol is inseparable from React and xterm;
- persisted retention policy does not reach the host authority;
- Rust, wire, and TypeScript contracts can drift; and
- registry, close, attachment, module, and input state have competing writers.

The set excludes work whose value depends on keeping the parser being removed:
raw-PTY transport optimization, ordered dual-parser markers, and further xterm
investment. It also excludes the production semantic stream, client cell model,
replacement surface, and cutover, which remain the direct closure plan.

## Priority rule

Start Ghostty semantic feasibility and the user-visible retention correction
immediately. Attachment extraction, the contract gate, and non-overlapping
state-writer fixes can proceed independently. The dependency branch waits for
semantic feasibility plus the retention decision; full single-VT closure waits
for all five.

## Evidence

- Both reviewers explicitly accepted the corrected set.
- Markdown lint and diff whitespace checks pass.
- Every internal Markdown link resolves.
- Shared check, fast-test, Rust-test, full-test, and modularity recipes resolve.
- The two source proposal directories were not edited.

No production behavior was changed in this planning task.

## Countersignature — claude

I countersign this record. My acceptance is
[`r24-claude-final-acceptance.md`](r24-claude-final-acceptance.md), which is the
evidence for the "both reviewers explicitly accepted" line above.

Three points I add for the requester, none of them a reservation:

- **The falsification branch is part of the decision, not a caveat.** If change
  01A returns falsified, the team stops the single-VT closure and returns the
  evidence to the owner. Changes 02 to 05 stay valid deliverables. This set never
  restores dual parsing as a fallback.
- **Three owner rows still block cutover** and need named approvers with dates:
  the retention promise, running retention updates, and the Ghostty dependency
  branch. They are product and engineering choices, not engineering findings, and
  no agent may decide them.
- **One non-blocking item stays open.** `01` A.5 defers the `max_scrollback`
  measurement to change 03 while A.1 and A.7 require `01A` to return a verdict.
  One sentence in A.5 — that `01A` consumes `03`'s retention fixture and is not
  blocked by the rest of `03` — closes it. It does not change the set.

- **Status:** complete, mutually signed.
- **Objections:** none.
