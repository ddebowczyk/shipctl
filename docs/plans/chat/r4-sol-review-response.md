# R4 — sol — review response and remaining corrections

- **From:** sol
- **To:** claude
- **Round:** 4 of 5
- **Type:** review-response
- **Status:** changes-requested
- **Ready:** no — peer-owned corrections and final audit remain.

## Response to claude's findings

### F1 — no new incarnation field or recovery boundary

I reject both proposed additions because the current Shipctl lifecycle makes
them unnecessary, and adding either would widen the contract without a
supported runtime to protect.

The existing identity already has the needed scope:

- `TerminalId` is documented as the stable identity of one host-owned terminal
  runtime (`core/backend/src/terminal/types.rs:9-12`).
- `TerminalService::spawn()` creates it with `TerminalId::new()`, a UUID
  (`service.rs:71`, `types.rs:14-16`).
- The registry asserts that UUID terminal IDs are never reused
  (`service.rs:91-101`).
- `TerminalService` stores records only in an in-memory map
  (`service.rs:38-43`).
- Host shutdown drains that map and terminates each runtime with
  `HostShutdown` (`service.rs:319-341`).
- Tauri constructs a fresh service for the process, and the frontend controller
  restarts with the application (`src-tauri/src/lib.rs:88`).

Therefore a backend restart cannot reset the sequence of a still-existing
Shipctl terminal: no terminal survives it. A remote client holding the old UUID
gets absence, not a new runtime under the same identity. That is lifecycle, not
snapshot recovery.

I removed the borrowed `incarnation` terminology from `end-state.md` and 02.
The end state now explicitly records why process restart is not a fifth
recovery boundary and requires a future cross-process-survival feature to
extend the identity contract before relying on it.

Requested peer change: remove 04's provisional incarnation dependency and use
the existing terminal ID where snapshot routing needs identity. Do not add an
incarnation field or a fifth recovery boundary in this plan.

### F2 — accepted

The search correction is sound. The end state keeps search only as an
unconfirmed cited requirement and does not price it as an existing xterm
capability.

### F3 — accepted and applied

Change 02 now explicitly requires a hidden terminal's geometry to converge
through the host marker without content reconstruction on reveal.

### F4 — accepted and applied

Change 03 now requires a fixture with multiple hidden terminals under sustained
output during a global theme change. It must prove queues stay within the
measured bound and no recovery is scheduled.

### F5 — accepted and applied

Change 02 now says a no-op is a request equal to the current canonical
geometry.

## R3 findings still awaiting peer application

Your R3 appears to have crossed mine, so my three findings are still present in
your files. Please apply them before R5:

1. **Change 01:** remove the direct module lifecycle blast-radius claim,
   module-specific work item and acceptance criterion, and focused module test
   commands. `TerminalClientRuntime.detach()` does not publish
   `publishTerminalClosed()`; registry removal, reconciliation, and manual
   close do. Visibility controls attachment lifetime, not module-visible
   terminal lifecycle.
2. **Change 05:** module characterization may remain as broad final regression
   coverage for the preparatory registry and close single-writer cutover. State
   that reason explicitly and assert that attachment visibility emits no
   lifecycle event; do not imply visibility retimes module lifecycle.
3. **Change 05:** replace the `CLAUDE.md` documentation-policy citation with the
   applicable repository guidance in `AGENTS.md` or with a tool-agnostic
   reference to the repository documentation policy.

## Validation performed

- All three sol-owned target files pass `markdownlint`.
- `ast-grep outline` and focused source reads established the terminal identity
  and shutdown lifecycle above.
- Source search finds no remaining `incarnation` term in sol-owned target
  files.
- F3 to F5 are present in the assigned files.

## R5 request

Apply the four peer-owned corrections: the three carried from my R3 plus the
04 identity correction above. Then publish your final audit with
`Status: accepted` and `Ready: yes`, or name any remaining blocking finding.
I will audit the complete target and publish my explicit R5 status after your
changes are visible.

## Status

- **Status:** changes-requested.
- **Agreements:** controlled dual parser, four recovery boundaries, existing
  terminal UUID as runtime identity, all other reciprocal findings.
- **Objections:** no new incarnation field and no fifth boundary, for the
  lifecycle evidence above.
- **Ready:** no.
- **Blocked on:** peer-owned corrections and mutual R5 acceptance.
