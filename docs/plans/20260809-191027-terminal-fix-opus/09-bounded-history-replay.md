# Phase 09 — Bounded, history-complete recovery replay

## Objective

Make the replay that survives — initial attach, renderer recreation, sequence
gap, queue overflow — reconstruct the newest **complete** history suffix the
host retained, within an explicit bound, reporting exactly why anything is
missing.

## Context

After phases 06-08, routine actions no longer replay. What remains is
recovery, and recovery is now the *only* place where exactness is promised.
Two properties are missing today:

- **No bound.** `VtReplayEngine::replay()` grows with retained history, and
  phase 01 deliberately increases retention. An unbounded channel message is
  not an acceptable recovery path.
- **No account of what is missing.** A renderer receiving a short replay
  cannot tell whether the host never had those rows or whether the snapshot
  dropped them.

Those are two distinct facts and must be reported separately:

- `host_eviction`: `none` | `row_limit` | `byte_limit` — why the host no
  longer holds older rows, naming which of phase 01's two bounds bound first.
- `snapshot_truncated`: the host still holds rows this snapshot omitted.

## Hypotheses to verify

**H9.1 — the retained history can be selected on complete row boundaries.**
A suffix must never begin mid-wrapped-logical-row, mid-UTF-8 sequence, or
mid-escape-sequence, and must always carry the full active grid plus cursor,
wrap state, modes, tabs and hyperlinks.
Method: select at many budgets across the VT corpus; reconstruct into a fresh
parser and xterm; compare.
Falsifier: a boundary exists where a complete suffix cannot be formed — the
selection then needs a coarser unit than a row.

**H9.2 — the active grid always fits.**
Method: worst supported geometry against worst measured formatter expansion
(wide Unicode, dense styling, hyperlinks).
Falsifier: the derived bound cannot encode a valid visible terminal — the
bound is wrong, not the content.

**H9.3 — snapshot `N` plus frames `N+1…M` equals a fresh snapshot at `M`.**
Method: inject output, resize, palette and metadata changes around the
boundary; compare final supported state.
Falsifier: any supported state differs — the boundary contract is broken and
phases 07-08's ordering guarantees do not hold across recovery.

**H9.4 — what the bound should be.** `OPEN DECISION`. Derive it from phase
01's retention measurements, phase 03's measured frame throughput, and the
1 MiB subscriber queue in `terminalOutputQueue.ts:11`. Record the formula and
the supported-geometry proof. Do not insert an unexplained constant, and do
not reuse cmux's number as an authority — it is a different renderer with a
different queue.

## Tasks

1. Land the H9.1 fixtures first: numbered, wide-Unicode, combining-grapheme,
   styled, wrapped, hyperlinked and blank rows at narrow and wide geometry,
   plus primary/alternate transitions and output produced with no renderer
   attached.
2. Add newest-complete-suffix selection to `VtReplayEngine::replay()`.
3. Derive and apply the bound from H9.4, recording its derivation in source.
4. Encode `retained_rows`, `host_eviction` and `snapshot_truncated` in the
   replay payload. A snapshot that carries only the active grid because
   history did not fit **must** report truncation; it is never a silent
   fallback.
5. If even the active grid cannot fit, return a typed attachment error with
   diagnostics rather than a partial or malformed replay.
6. Add controller tests that hold live frames during install, drop duplicates
   at or below `N`, accept `N+1`, and reattach on a gap.
7. Add equivalence fixtures for each recovery trigger: initial attach,
   renderer recreation, injected gap, queue overflow, and recovery after
   several resize and theme changes.

## Acceptance criteria

- The selected history is a newest complete suffix; no fixture reconstructs a
  broken row, glyph or sequence.
- `host_eviction` names which phase-01 bound discarded older rows;
  `snapshot_truncated` is true only when the host held rows the snapshot
  omitted.
- A new renderer recovers everything the host retained within the bound,
  including output produced while nothing was attached.
- Snapshot plus subsequent live frames equals a fresh snapshot at the same
  sequence, across the corpus.
- Gap and overflow each perform exactly one reset and install, losing and
  duplicating nothing after the boundary.
- No recovery path degrades silently, and no bound appears in source without
  its derivation.

## Validation

```sh
just test rust
just test fast
just check all
```

Extend `research/20260809-124553-fut-tty/vt-proof` rather than starting a new
harness; its README records the pinned revisions and the divergence boundary
this phase's equivalence claims rest on.

## Rollback

Independent of phase 08. If H9.4 cannot produce a defensible bound, ship the
selection and reporting without the bound and record the unbounded payload as
a known limitation — do not invent a cap to close the phase.

## Out of scope

Disk-backed history, and any change to how often replay is produced — that is
settled by phases 06-08.
