# Fut terminal-handling comparison

Dated working notes from a session comparing `~/projects/_agents/fut` (an
agent-aware terminal multiplexer) against shipctl's terminal capability, to
identify what shipctl can adopt.

These files are **verbatim transcripts** of the session, question and answer,
recorded for handover to the engineering team. They are analysis and
recommendation only — no code was changed, and nothing here has been ratified
as a decision.

- `01-terminal-architecture-comparison.md` — the full comparison: three defects
  found in the current PTY path, the structural difference between the two
  systems, five ranked recommendations, and what explicitly not to copy.
- `02-host-owned-terminal-state.md` — follow-up elaboration on the single
  structural claim from `01`: what "the host owns terminal state" means
  mechanically, how the four problems trace back to it, and a cost ladder that
  is cheaper for shipctl than it was for fut.

Line references point at the working tree as of 2026-08-09 and will drift.

Evidence base: `~/projects/_agents/fut` at v0.2.0 (`src/terminal/runtime.rs`,
`src/terminal/ghostty.rs`, `src/resources.rs`, `src/daemon/mod.rs`,
`src/domain.rs`, `src/cli.rs`, `PERF.md`, `integrations/pi/fut.ts`) and this
repo's `core/backend/src/terminal/`, `core/frontend/terminal/`, `cli/src/`,
`core/backend/src/instance/protocol.rs`.

Related prior art in this repo, which reached the same diagnosis of the reload
problem independently and deferred it:
`docs/plans/20260808-072927-ext-plus-thin-core/feedback-round-2/02-resource-ownership-and-pty.md`
and `research/shep-core-and-modules/31-terminal-session-rail.md`.
