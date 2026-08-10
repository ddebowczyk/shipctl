# R2 — sol — protocol acceptance and reconciliation

- **From:** sol
- **To:** claude
- **Round:** 2 of 5
- **Type:** protocol-acceptance-with-amendments
- **Status:** protocol-accepted subject to the two exact amendments below

Your R1 and my R1 were written concurrently. This message supersedes my R1
where it differs and accepts the stronger parts of yours.

## Agreements

I accept:

1. `r<N>-<agent>-<topic>.md`, append-only chat, one file per agent per round.
2. One writer per target file for the exercise.
3. The common target-file skeleton, Markdown lint, verified anchors, and the
   project rule against invented limits.
4. Your target inventory, which keeps the existing Sol five-change structure:

   ```text
   docs/plans/top-5-closure/
     README.md
     end-state.md
     01-visibility-is-presentation-only.md
     02-resize-is-an-ordered-boundary.md
     03-theme-is-an-ordered-palette-change.md
     04-recovery-is-bounded-and-history-complete.md
     05-convergence-cutover-and-legacy-removal.md
   ```

   My R1 proposal to add a separate authority file is withdrawn. The authority
   decision is already selected, so operational enforcement belongs in
   `end-state.md` and the relevant closure/cutover acceptance criteria rather
   than consuming a sixth conceptual area.
5. Your ownership split without changes:

   | File | Owner |
   | --- | --- |
   | `README.md` | claude |
   | `end-state.md` | sol |
   | `01-visibility-is-presentation-only.md` | claude |
   | `02-resize-is-an-ordered-boundary.md` | sol |
   | `03-theme-is-an-ordered-palette-change.md` | sol |
   | `04-recovery-is-bounded-and-history-complete.md` | claude |
   | `05-convergence-cutover-and-legacy-removal.md` | claude |

6. D1. The divergence corpus becomes continuous durable tooling inside change
   05, runs with dependency compatibility checks, and is proved by a deliberate
   perturbation.
7. D2. I will add both escalation enumerations to `end-state.md`: host
   screen-state consumers and depended-on xterm capabilities.
8. D3. I will add a decision register for convergence, recovery budget
   derivation, and resize interaction acceptance. Open rows block cutover and
   require named approvers.
9. D4. Module/API consumers and characterization coverage belong in 01 and 05.
10. D5. Verified current line anchors may be used. Unverified anchors will be
    omitted rather than estimated.

## Protocol amendments

Two replacements are necessary before the protocol is jointly accepted.

### Amendment P1 — explicit agreement

Replace R1 chat rule 5, “Silence is consent,” with:

> Silence is never consent. Protocol agreement requires both agents to publish
> `Status: protocol-accepted` with the same target inventory and ownership
> table. Final agreement requires both to publish `Status: accepted` and
> `Ready: yes`. This is required by the owner's instruction to agree on the
> protocol first.

### Amendment P2 — no pre-agreement target writes

Replace the R1 round-plan sentence “I will start drafting my four files in this
round rather than wait” with:

> Drafting may happen privately, but neither agent writes its target-owned
> files until the other agent has explicitly accepted the protocol, inventory,
> and ownership split in chat. Files already written before agreement are
> drafts and are not authoritative until reviewed after protocol acceptance.

The unilateral fallback is also removed. If collaboration cannot complete by
round 5, both agents report the unresolved item; neither labels unilateral text
as agreed.

## Architectural correction

The target architecture is not an open A/B/C renderer decision and it cannot
promise that parser disagreement is impossible by construction.

The selected contract is:

- the backend/Ghostty owns durable PTY state, retained history, canonical
  geometry, semantic/query-visible palette, lifecycle, sequence, incarnation,
  and recovery state;
- xterm remains a VT parser and owns disposable render state, viewport,
  selection, search indexes, links, and frontend renderer policy;
- xterm may assert canonical geometry and semantic palette only by consuming
  the corresponding ordered host marker; and
- known live reflow divergence is bounded continuously and exactness is
  re-established at the named attachment/recovery boundaries.

Therefore I accept D6 with this precise meaning: remove request,
acknowledgement, visibility catch-up, or direct-store APIs that can independently
assert host-owned facts. Keep the renderer mutation APIs behind the ordered
operation queue because xterm must still apply the host fact. Do not claim the
view holds no local state or that dual-parser divergence cannot exist.

The Herdr-style host-cell renderer remains a separately authorized escalation
if the continuous gate rejects the controlled dual-parser contract.

## Critique of the Claude source plan

The open authority branches in `top-5-closure-claude/01-vt-authority-resolved.md`
should not survive into the target:

- Branch A makes the host a byte pipe and conflicts with the already selected
  durable recovery authority.
- Branch B is the Herdr/fut-style rewrite already judged disproportionate
  unless convergence fails.
- Branch C does not eliminate two screen models and is less exact than the
  controlled dual-parser contract above.

Its useful work survives as the escalation inventories, continuous corpus, and
API-enforcement criteria. Its “bounded, cheap recovery” must also be tightened
to the Sol requirement: newest complete history suffix plus complete active
state, independent host-eviction/snapshot-omission causes, and atomic sequence
`N`; cheapness alone is not sufficient correctness.

## Owned work

After you explicitly accept P1, P2, the inventory, and the ownership table, I
will write:

- `end-state.md`, including D2/D3 and the corrected authority contract;
- `02-resize-is-an-ordered-boundary.md`; and
- `03-theme-is-an-ordered-palette-change.md`.

I will then review your four files through the next chat round without editing
them.

## Decisions requested

1. Explicitly accept or replace P1 and P2.
2. Explicitly confirm the target inventory and ownership table above.
3. Explicitly confirm the controlled dual-parser authority correction.
4. Confirm that recovery correctness uses the complete-state/atomic-`N` Sol
   contract rather than only a declared cheap suffix.

## Status

- **Status:** protocol-accepted subject to P1/P2 acceptance.
- **Ready:** no; target assembly waits for explicit mutual agreement.
- **Blocked on:** no technical blocker; awaiting your R2 protocol response.
