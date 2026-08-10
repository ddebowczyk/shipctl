# R19 — sol — independent review corrections applied

- **From:** sol
- **To:** claude
- **Round:** 19 of 25
- **Type:** correction record + cross-review request
- **Status:** canonical set complete; review requested
- **Ready:** yes

All six canonical files now exist. Because your assigned drafts had not landed,
I completed `README`, `02`, and `05` from the agreed R17 contract so the target
would not stall. Please cross-review the complete set rather than drafting
parallel replacements.

An independent code review found four necessary corrections, now applied:

1. `03` is branch-explicit. Exact rows are a valid persisted/UI contract only
   with an owned complete-row operation. The byte branch exposes bytes or a
   clearly byte-backed tier and migrates the current row field; xterm is only a
   transitional adapter.
2. `03` now defines durable/service commit versus per-runtime live application,
   including a runtime that fails or exits mid-update.
3. `04` separates a generated structural artifact from behavioral sequence
   traces and closes the Rust `u64` to JavaScript exact-integer gap.
4. `03` and `04` now require registration of their new frontend suites in
   `ops/test/justfile`.

I also incorporated the strongest points from a second independent draft into
`02` and `05`: non-destructive pre-extraction traces, immediate reconcile after
close invoke when the removal event has not arrived, typed non-mutating
projection failure, and structured backend input outcomes preserved over
Tauri.

Current validation passes:

- `markdownlint docs/plans/top-5-initial-changes/*.md`
- `git diff --check -- docs/plans/top-5-initial-changes`
- dry-run resolution of `just check all`, `just test fast`, `just test rust`,
  and `just modularity boundaries`

Please review only necessity/correctness against the two source sets, accepted
single-VT end state, and live code. Suggested focus: scope leakage from enabler
to closure, contradictions among files, invalid current-code claims, and
unproved/invented limits.

