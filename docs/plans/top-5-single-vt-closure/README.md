# Single-VT terminal closure

Start with [end-state.md](end-state.md). It carries the architecture decision,
the root cause, the recovery contract, and the completion contract. This file
is the index.

The preparatory set in [`terminal-top-5-changes-sol`](../terminal-top-5-changes-sol/README.md)
makes the terminal capability safe to change. This set is the change.

## The five changes

| # | Change | Closes |
| --- | --- | --- |
| 1 | [Semantic contract and retention are proven](01-ghostty-semantic-contract-and-retention-are-proven.md) | the cell contract is unproven |
| 2 | [Semantic frame transport is versioned](02-semantic-frame-transport-is-versioned-and-measured.md) | PTY bytes reach the frontend |
| 3 | [Attachment model is renderer-independent](03-attachment-model-is-renderer-independent.md) | attachment logic lives in the DOM |
| 4 | [Cell surface replaces xterm capabilities](04-cell-surface-replaces-xterm-capabilities.md) | xterm supplies unpriced behavior |
| 5 | [Single-VT cutover removes duplication](05-single-vt-cutover-removes-parser-duplication.md) | two parsers, and drift returns |

## In one paragraph

Ghostty parses PTY bytes in the host and xterm parses the same bytes again in
the frontend. Two parsers evolve terminal state independently, so Shipctl uses
host replay plus `term.reset()` as a general convergence mechanism, and routine
presentation changes — resize, theme change, hide and show — each become
terminal reconstruction. This plan removes the second parser. The host owns
terminal meaning and emits versioned screen snapshots, deltas, history windows,
and ordered side effects; the frontend owns pixels, gestures, and viewport
intent, and never parses PTY bytes or ANSI. The five changes prove the semantic
contract and the retention contract, carry them over a versioned binary
transport, move the attachment model out of the DOM, replace every capability
xterm supplies today, and then cut over and delete the duplicate parser.

## Decision history

This plan replaces [`../top-5-closure/`](../top-5-closure/README.md), which
selected a *controlled dual parser*: both parsers retained, with ordered
`Resized` and `PaletteChanged` markers making them agree. That decision was
signed off and is now superseded. The earlier plan is preserved unchanged as the
audit record; the reasoning that produced it is in `docs/plans/chat/` rounds 1
to 5, and the reversal is argued in rounds 6 onward.

Two pieces of evidence caused the reversal, both absent when the earlier
decision was made:

- An independent review argued that ordered xterm barriers are a mitigation and
  not a destination, because two emulators remain
  ([terminal-solution-critique.md](../terminal-solution-critique.md)).
- Neither agent had read the API of the dependency already shipped. The pinned
  `libghostty-vt` (`core/backend/Cargo.toml:23`) exposes cells, styles,
  graphemes, wide cells, hyperlinks, wrap state, cursor, modes, palette,
  screens, selection with word, line, and output semantics, and — the part
  expected to block the migration — key, mouse, and paste encoding including
  kitty flags, `modify_other_keys`, and macOS option-as-alt. The host-cell
  escalation had been priced without that fact, and the price was wrong.

The reversal is recorded rather than erased, because the strongest argument in
this plan for measuring before committing is that the previous plan did not.
One cost moved in the opposite direction and is recorded for the same reason:
what the frontend must rebuild is larger than the earlier plan assumed. A second
claim — that several capabilities are exposed only through the unsafe `-sys`
bindings — was itself wrong for the selection gesture machine, which has a safe
wrapper at `crates/libghostty-vt/src/selection/gesture.rs`. Where a gap is real,
such as the OSC 9 payload, it belongs to change 01's proof and not to an
assumption in either direction.

## Implementation order

The order is a dependency chain, not a preference.

```text
1 contract ──> 2 transport ──> 3 attachment ──> 4 surface ──> 5 cutover
```

- The semantic and retention contracts must be proven against the real
  dependency before any transport is designed to carry them.
- The transport must be versioned and measured before the client model is built
  on it.
- The attachment model must be renderer-independent before a renderer exists,
  or it grows DOM assumptions that block the surface work.
- The cell surface is the largest change and must not start before changes 1 and
  2 have closed their unknowns.
- Cutover removes the second parser and every path that depended on it.

The executable falsification spike is work inside changes 1 and 2, not a reason
to delay writing the plan. If it falsifies the destination, the work stops and
returns evidence to the requester. It does not silently restore dual parsing as
the end state.

## Migration fallback

The existing xterm path may exist behind exactly one migration switch. It
receives no new features, serves as the comparison oracle for change 4, and is
deleted by change 5. Dual parsing is never an end state and is never retained
after cutover.

## Before starting

- The preparatory work in
  [`terminal-top-5-changes-sol/README.md`](../terminal-top-5-changes-sol/README.md)
  is a prerequisite in part, not in whole. Required: the DOM-free attachment
  seam, retention authority, dependency ownership, the exhaustive
  protocol-mapping principle, and the single-writer state work. Superseded: its
  production raw-PTY Tauri output and input cutover, which would optimize the
  parser path change 05 deletes. Change 02 carries the first production hot-path
  transport change, using semantic frames.
- Its three register rows — the scrollback row domain, running retention
  updates, and the libghostty-vt dependency branch — must be closed with named
  approvers. Two of them are now more consequential, not less: the host becomes
  the sole owner of terminal meaning and of history, and the pinned API accepts
  a retention limit only at construction.
- The decision register in [end-state.md](end-state.md) governs this plan. An
  open row blocks cutover.

## Common validation

Each change lists focused validation. The shared repository gates are:

```sh
just check all
just test fast
just test rust
just test full
just modularity boundaries
markdownlint docs/plans/top-5-single-vt-closure/*.md
git diff --check
```

New frontend terminal suites are registered in `ops/test/justfile` in the same
commit, in the single serial terminal entry the preparatory work consolidates.
Tests that mutate shared terminal caches or runtime singletons run with
`--test-concurrency=1`.
