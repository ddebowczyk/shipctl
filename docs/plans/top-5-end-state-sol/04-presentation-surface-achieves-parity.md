# Presentation surface achieves parity

## Outcome

A presentation-only surface paints the area 03 model and reaches proven parity
with the current product surface. It interprets no VT, holds no terminal
authority, and owns no continuity. Every capability Shipctl receives from xterm
today is either reproduced, or deliberately dropped by a named approver on a
dated row.

This area owns pixels and the capability register. It does not own client state,
which is area 03's, and it does not delete anything, which is area 05's.

## Context and purpose

Removing xterm removes behaviour that has no call site. That sentence is the
whole risk. `end-state.md:172-201` lists the parity surface, and the list is
correct — but a list is not a gate. `end-state.md:227-228` already states the
rule that makes it one: open rows block area 4 and final cutover, and a row
closes only with evidence, the selected contract, a date, and a named approver.
Three rows in that same register closed under exactly that discipline.

The parity list has none of those columns. This area gives it them. That is the
single decision this area exists to protect, because a capability that dissolves
back into prose is a capability that gets discovered missing after deletion.

Two classes of capability need different treatment, and conflating them is how
parity work goes wrong:

**Explicit, with a call site.** These are findable and cheap to enumerate.
`TerminalView.tsx` alone holds scrollback (`:83`), fit (`:93-94`), Unicode 11
(`:95-97`), web links to `openUrl` (`:98-100`), the single input path
(`:104-125`), the bell (`:128-130`), the OSC 9 handler (`:133-140`), and custom
key handling (`:142-150`). WebGL and its fallback sit in
`terminalRendererAddons.ts`; measurement in `terminalMeasure.ts`; theme in
`terminalTheme.ts`.

**Implicit, with no call site.** Grapheme clustering, wide-cell layout, wrap at
the boundary, cursor forms, selection paint and gesture semantics, IME
composition, mouse reporting, sustained-output scheduling, and the current
focusable labelled-input accessibility baseline. Nobody wrote a line to get
these. Nobody will notice the line that removes them.

Two rows deserve naming here because they are already known and still unowned.
The OSC 9 payload gap is tracked in `docs/ops/terminal-osc9-upstream-task.md`,
and that page contradicts itself on when the work starts: it says to start early
because the merge is not ours to schedule, and it also says the clock starts at
closure area 5 and nothing is blocked until then. Both cannot be true. The
second reading is the dangerous one, because an upstream merge we do not control
cannot be scheduled backwards from a cutover date.

The Unicode row is the one that looks cosmetic and is not.
`@xterm/addon-unicode11` (`package.json:31`) is pinned explicitly at
`TerminalView.tsx:97` with `term.unicode.activeVersion = "11"`. Ghostty reports
widths from its own table. A width-table difference changes which cells are
double width, which changes where lines wrap, which moves every row anchor in
retained history. It is a continuity fact wearing a rendering costume.

## Dependencies

- **Blocked by.** Area 03 for the model to paint. The register does not wait: it
  opens at this area's kickoff, because an unavailable accessibility, IME, glyph
  or input capability invalidates the surface design before it is built.
- **Blocks.** Area 05. An open row blocks cutover, per `end-state.md:227`.
- **Consumes.** Area 01 item 8, which records the width table the projection
  reports. This area owns the comparison against the client pin; area 01
  correctly declined to settle it.

## Affected areas

- `core/frontend/terminal/TerminalView.tsx` — every capability call site above.
- `core/frontend/terminal/terminalRenderer.ts`,
  `terminalRendererAddons.ts` — the current renderer and its fallback.
- `core/frontend/terminal/terminalMeasure.ts`,
  `terminalTheme.ts`, `terminalViewport.ts` — measurement, theme and viewport
  painting.
- `core/frontend/terminal/terminalRetention.ts:31` —
  `TRANSITIONAL_RENDERER_SCROLLBACK_ROWS`, a row count standing in for a byte
  budget. Its name says transitional; this area is where it stops being needed.
- `docs/plans/top-5-single-vt-closure/end-state.md:172-201` — the prose list
  this register replaces.

## The capability register

The register is a table, kept in this plan, with one row per capability and
these columns:

| Column | Meaning |
| --- | --- |
| Capability | One observable behaviour, not a component |
| Evidence | Call site, or the fact that there is none |
| Disposition | Reproduce, drop, or defer |
| Owner | Named person accountable for the row |
| Opened | Date the row was opened |
| Decided | Date the disposition was approved |
| Approver | Named person who approved it |

Owner, Opened, Decided and Approver are left unset in this plan on purpose.
Inventing a name or a date would fake exactly the authority the register exists
to record. They are filled at kickoff by the owner, and the plan is wrong until
they are.

Rows that open at kickoff rather than at cutover, because their resolution is
not ours to schedule or because they gate design rather than delivery:

**Row 0 — OSC 9 notification payload.** Evidence:
`docs/ops/terminal-osc9-upstream-task.md`, and the handler at
`TerminalView.tsx:133-140`. It opens now because the upstream merge is not ours
to schedule, and a clock anchored to cutover cannot run backwards.

**Row 1 — bell.** Evidence: `TerminalView.tsx:128-130`, `term.onBell` into
`notifyAgent`. A distinct effect from OSC 9 with its own call site. Folded into
the notification row, it is lost silently.

**Row 2 — Unicode width table.** Evidence: `package.json:31`,
`TerminalView.tsx:97`, compared against area 01 item 8. A width difference moves
every row anchor in retained history. It gates the model, not the paint.

**Row 3 — accessibility baseline.** Evidence: the current focusable labelled
input; `screenReaderMode` is not enabled. `end-state.md` already states this is
the baseline rather than xterm's live-region manager. The row records that
decision instead of relying on a reader remembering it.

**Row 4 — IME composition.** Evidence: no call site. Implicit, and it cannot be
retrofitted onto a surface that did not plan for it.

Every remaining capability in `end-state.md:172-201` becomes a row with the same
columns. The list is the input; the register is the artifact.

## Work to be done

1. **Open the register at kickoff and fill the identity columns.** Owner and
   Opened for every row, before surface work starts. A row with no owner is not
   a row.
2. **Enumerate the explicit capabilities from call sites, not from memory.**
   The eight frontend files that import `@xterm` are the search boundary:
   `TerminalView.tsx`, `terminalRenderer.ts`, `terminalRendererAddons.ts`,
   `terminalOutputQueue.ts`, `terminalCache.ts`, `terminalMeasure.ts`,
   `terminalTheme.ts`, `terminalViewport.ts`. Two of those eight leave in area
   03; the register covers what the other six do.
3. **Enumerate the implicit capabilities deliberately.** They have no call site,
   so they must come from the `end-state.md` list and from characterisation of
   the running product, not from reading code.
4. **Resolve row 2 before the surface design is fixed.** Compare the width table
   area 01 reports against the Unicode 11 pin, with its `libghostty-vt` version
   recorded. Any difference is an owner decision about retained-history
   continuity, and it is cheaper before a surface exists than after.
5. **Start row 0 now.** The upstream OSC 9 work begins at this area's kickoff.
   Correct the contradiction in `docs/ops/terminal-osc9-upstream-task.md` so the
   page states one start condition. If the payload cannot land upstream, the row
   closes as an approved drop with a named approver, not as an open item carried
   into cutover.
6. **Build the surface as presentation only.** It paints the area 03 model,
   submits semantic commands, and holds no terminal state. It has no parser, no
   buffer, and no mode interpretation. Neither WebGL nor two implementations is
   mandated; the surface must prove observable transparent and opaque behaviour,
   performance, and failure fallback for the supported product.
7. **Paint the defined in-flight and loss states.** Area 03 defines the state
   while a history window is in flight or an anchor is evicted. This area paints
   it explicitly. A blank or shifting row that emerges as a side effect is a
   defect, and any visible compromise needs a product decision and a row.
8. **Retire the transitional row constant.** `TRANSITIONAL_RENDERER_SCROLLBACK_ROWS`
   (`terminalRetention.ts:31`) exists because the renderer needed a row count
   while the host's budget is bytes. When the host serves history windows, the
   surface no longer needs a row budget. Removing it is a criterion here, and
   the deletion lands in area 05 with its three call sites.
9. **Keep xterm as the comparison oracle, never as the specification.** The
   parity harness compares the new surface against the running xterm surface on
   the area 01 corpus. It is migration evidence, and it is deleted in area 05
   with the packages. Where the two disagree, the semantic model decides which
   is correct — xterm's behaviour is not automatically the target.
10. **Do not use `useEffect` to derive presentation state.** Geometry, theme and
    visibility are derived or handled at their source. Effects remain
    legitimate for ResizeObserver, for listener setup, and for the imperative
    surface integration itself.

## Acceptance criteria

1. Every capability in `end-state.md:172-201` appears as a register row with all
   seven columns filled. A row with an empty Owner or Approver is an open row.
2. No row is open. Per `end-state.md:227`, an open row blocks cutover, so area
   05 cannot start while one remains.
3. Rows 0 to 4 have a Decided date at or before the date the surface design is
   frozen — not at cutover. Proven by the dates in the table.
4. `docs/ops/terminal-osc9-upstream-task.md` states one start condition, and it
   is not anchored to closure area 5.
5. The width comparison is recorded with both table versions. If they differ,
   the owner decision and its consequence for retained history are written down
   before the surface design freezes.
6. Every reproduced capability is proven on the new surface through the
   production codec and the production model: alternate screen entry and exit,
   OSC 8 links, plain-text link detection and safe activation, selection, copy,
   paste, graphemes and wide cells, application palette, mouse modes, IME
   composition, bell, OSC 9, title, exit, and no-surface-output behaviour.
7. Every dropped capability has a named approver and a dated row. A capability
   discovered missing after area 05 without a row is a failure of this area,
   traced back here.
8. The parity harness runs the area 01 corpus against both surfaces and reports
   differences per case. Each difference is resolved to the semantic model, not
   to whichever surface is more familiar.
9. Release-mode measurements: frame throughput and allocation, snapshot install
   time, resize latency and drag behaviour, hidden-pane work, and
   cache-missing history-window latency. Compared against the area 02 baselines
   using the recorded method. A regression is explained against a recorded
   constraint, never waived.
10. A manual macOS pass with the packaged application: long history, an
    interactive shell, a resize-aware full-screen program, a non-Latin input
    method, and both transparent and opaque themes.

## How to validate

```sh
node --test --test-concurrency=1 core/frontend/terminal/tests
just test fast
just check all
just modularity boundaries
markdownlint docs/plans/top-5-end-state
```

The register is validated by reading it. Every column filled, every row closed,
every date before the freeze.

## Exit and rollback

The surface is additive behind the single migration switch that area 05 owns and
removes. Both surfaces exist briefly; xterm stays visible and authoritative for
pixels until area 05 flips and deletes in one change.

The stop condition is item 6 and criterion 7. If the surface cannot meet a
required accessibility, IME, input, rendering or performance capability, the
evidence goes to the owner and the row closes as an approved drop or the
architecture is revised. It does not close as an assumption, and cutover does not
proceed past an open row.
