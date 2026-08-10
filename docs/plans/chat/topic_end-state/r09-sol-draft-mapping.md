# Round 09 — sol draft mapping

- From: sol
- To: independent reviewer
- Round: 09 of 12
- Type: target-draft handoff and self-audit
- Evidence boundary: canonical rounds 01-08, the original closure set, live
  code, and the six sol-owned target files

## Ownership

Sol exclusively owns this file and every file under
`docs/plans/top-5-end-state/`. The independent reviewer may report corrections
in reviewer-owned round 10 but must not edit the target set.

## Drafts ready for review

The target set now contains one self-contained index and five authority plans:

1. `README.md`
2. `01-host-semantic-authority-is-production.md`
3. `02-semantic-protocol-reaches-every-client.md`
4. `03-client-model-owns-terminal-continuity.md`
5. `04-presentation-surface-achieves-parity.md`
6. `05-cutover-deletes-the-second-vt.md`

`markdownlint docs/plans/top-5-end-state/*.md` passes.

## How the drafts map current authority to target authority

### Area 01

Moves production meaning from `VtReplayEngine` plus browser interpretation into
owned backend values and semantic commands. It names `RuntimeActor` operations,
the formatter path, domain types, compatibility corpus, retention authority,
selection, effects, host input encoding, dirty invalidation, theme ownership,
and the OSC 9 stop gate.

It leaves wire baselines and encoding to area 02 and delays formatter deletion
until area 05.

### Area 02

Moves the client boundary from child bytes and ANSI replay to one versioned
semantic contract. It covers terminal domain and contract files, Tauri,
bootstrap, control socket, CLI, lossless counters, atomic application, history
anchors, occurrence effects, commands, versioning, and measured transport
selection.

It assigns CLI semantic records to area 02, local painting to area 04, and
cutover to area 05. Control base64 remains legal only for semantic payloads.

### Area 03

Moves durable browser state from xterm into the existing DOM-free attachment
seam. It covers atomic model commits, history, viewport intent, projected
selection, effects, lifecycle admission, hidden updates, surface recreation,
and exactly four recovery boundaries.

It preserves `TerminalClientRuntime` as descriptor writer and bans a second
React, Zustand, renderer, or runtime model writer.

### Area 04

Moves webview and CLI presentation off the child stream. It covers the current
xterm view, addons, measurement, renderer, cache, viewport, theme, queue, and
CLI raw painter responsibilities. The host supplies exact Unicode cell
occupancy; the surface owns pixels and browser integration only.

The capability register distinguishes existing requirements from capabilities
that xterm happens to offer. Search and screen-reader live-terminal behavior are
not invented as migration requirements without current product evidence or an
owner decision.

### Area 05

Owns the sole switch from introduction through deletion, coordinates every
consumer, and names the legacy deletion inventory. It distinguishes forbidden
child or replay payloads from valid backend PTY bytes, binary semantic codecs,
control encoding, and locally generated CLI ANSI.

It requires independent host-to-semantic and semantic-to-presentation fixture
halves, production adapters, packaged scenarios, deliberate negative-gate
failure, and removal of the switch itself.

## Round 08 correction coverage

- **Production seam and dirty invalidation:** area 01 work and acceptance.
- **Complete selection and host occupancy:** area 01, with presentation use in
  area 04.
- **OSC 9 before protocol freeze:** area 01 gate and area 02 dependency.
- **Lossless counters and atomic bootstrap:** area 02 work and acceptance.
- **Delta equivalence and atomic rejection:** area 02 and area 03 traces.
- **History and occurrence-effect ordering:** areas 01-03 by authority.
- **Hidden continuity and model-loss distinction:** area 03.
- **Browser plus CLI presentation:** area 04 with asymmetric dependencies.
- **Sole switch lifetime:** area 05 from introduction through deletion.
- **Exact legacy inventory and permitted byte exceptions:** area 05.
- **Two-half conformance and deliberate negative failure:** area 05.
- **No invented limits:** README and every area validation section.

## Decisions intentionally left evidence-driven

The drafts do not invent:

- a semantic transport codec;
- Tauri frame or batch size;
- flow-control queue capacity;
- history window size;
- renderer technology;
- performance or memory thresholds;
- comparison sample count; or
- soak duration.

Each is selected only from a technical contract, product requirement, or
recorded packaged measurement. The plans define the evidence and authority
needed to make the decision.

## Round 10 review request

Review the target files without editing them and report only corrections that
are necessary to meet the accepted end state. Check:

1. every remaining production authority has exactly one target owner;
2. no implemented enabler is mistakenly replanned;
3. every area has a production-path proof and an absence proof where authority
   moves;
4. the CLI, control socket, Unicode, OSC 9, effects, history, and migration
   boundaries remain consistent across files;
5. the plans are executable without another plan or research directory; and
6. any acceptance criterion that cannot actually prove its claim.

Report proposed text-level corrections in reviewer-owned round 10. Do not apply
them to sol-owned target files.

## Status

Round 09 complete. All six target files are drafted, their authority mapping and
round-08 corrections are accounted for, and the set is ready for independent
cross-review.
