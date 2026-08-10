# Round 05 — sol five-area decision

- From: sol
- To: independent reviewer
- Round: 05 of 12
- Type: decomposition decision and delivery ordering
- Evidence boundary: canonical rounds 01-04, the original closure set, and the
  live-code audit

## Decision

Adopt the five areas reconciled in round 04. They are the smallest set that
closes each remaining authority boundary without repeating the implemented
enablers:

1. `01-host-semantic-authority-is-production.md`
2. `02-semantic-protocol-reaches-every-client.md`
3. `03-client-model-owns-terminal-continuity.md`
4. `04-presentation-surface-achieves-parity.md`
5. `05-cutover-deletes-the-second-vt.md`

The target is not merely a better replay architecture. The target is one VT
authority: Ghostty parses PTY output and encodes terminal-aware input in the
backend; every client receives semantic state and submits semantic commands;
the browser paints an owned client model and never interprets VT.

## Why these are the top five

Each area removes one authority duplication visible in the current production
path:

- **01:** Ghostty parses output, but xterm still supplies usable browser
  semantics and mode-aware input. Closure requires the backend to project all
  required terminal meaning and encode input without ANSI formatting or
  browser mode interpretation.
- **02:** Raw PTY and reconstructed ANSI are the contract for Tauri, the
  control socket, and the CLI. Closure requires every adapter to carry one
  versioned semantic contract with common ordering, baselines, recovery, and
  fail-closed decoding.
- **03:** xterm owns the durable browser buffer, history, viewport, and
  selection projection. Closure requires the DOM-free attachment to apply
  semantic state to a persistent renderer-independent model, including while
  hidden.
- **04:** xterm parses, measures, renders, links, selects, and encodes browser
  input. Closure requires a presentation-only surface to meet accepted
  capability and performance evidence without terminal authority.
- **05:** Legacy and semantic paths coexist by design during migration.
  Closure requires every client to cut over, deletion of raw, replay, and
  xterm paths, and negative gates that prevent their return.

No item can be deleted without leaving either two VT authorities or an
unproven replacement. Retention, contract exhaustiveness, the controller seam,
and single-writer lifecycle state are prerequisites already implemented; they
remain regression gates inside the five areas rather than becoming more work
areas.

## Dependency and concurrency decision

The authority dependency is:

```text
01 host semantics
  -> 02 semantic protocol
  -> 03 client model
  -> 04 presentation surface
  -> 05 global cutover and deletion
```

That graph does not require strictly serial staffing. Area 04 starts its
capability register and surface feasibility work alongside area 01. Area 02 can
build contract fixtures once area 01's domain types stabilize. Area 03 can
evolve controller trace fixtures against those decoded domain fixtures before
the transport is selected. The acceptance dependency remains sequential: a
downstream area cannot declare completion using a legacy upstream authority.

## Migration discipline

- Preserve the current path until the replacement for the affected boundary is
  proved; additive migration is allowed before area 05.
- Keep one explicit product migration switch, owned and deleted by area 05.
- Never add a third terminal model or a transport-specific semantic model.
- Keep xterm only as the legacy implementation and comparison oracle. It does
  not define target semantics.
- Do not convert resize, theme, or visibility into recovery boundaries on the
  semantic path. Recovery remains limited to the four accepted conditions.
- Derive transport flow-control and performance limits from measurements and
  product requirements; the plans must not invent thresholds.

## Stop conditions

The program stops for an owner decision rather than preserving a hidden second
authority when:

- the pinned Ghostty API cannot expose a required semantic fact or effect;
- the OSC 9 payload gap remains unresolved and no explicit capability
  disposition is approved;
- the proposed surface cannot meet a required accessibility, IME, input,
  rendering, or performance capability; or
- a non-webview client is shown to require transported child PTY bytes rather
  than a local presentation adapter over semantic state.

## Drafting instructions for rounds 06-08

Each plan must state its outcome, completed-enabler boundary, dependencies,
affected live modules and symbols, work, acceptance criteria, validation, and
exit conditions. Acceptance must include deletion or negative proof where an
authority moves. The README must lead with the end state and dependency graph,
not with investigation history.

## Status

Round 05 complete. The five filenames, authority boundaries, dependency order,
migration owner, and stop conditions are fixed for challenge in round 06.
