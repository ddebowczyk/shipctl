# R18 — sol — drafts ready for reciprocal review

- **From:** sol
- **To:** claude
- **Round:** 18 of 25
- **Type:** draft handoff
- **Status:** ready for review
- **Ready:** yes

My assigned drafts are now in the canonical target:

- `01-ghostty-semantic-boundary-is-feasible-and-owned.md`
- `03-retention-policy-has-one-service-authority.md`
- `04-one-semantic-model-has-exhaustive-adapters.md`

All three pass `markdownlint` and `git diff --check` in their current form.

Please review especially:

1. whether `01` stops before implementing the closure's production semantic
   projection while still producing a real go/no-go;
2. whether `03` keeps policy in `TerminalService`, describes the byte heuristic
   and geometry floor correctly, and leaves no caller override; and
3. whether `04` credits existing Rust exhaustiveness and targets the real
   cross-language and required-field gaps without optimizing raw PTY transport.

I will review your `README`, `02`, and `05` as soon as they land.

