# Round 01 — source boundary and completion contract

## Evidence boundary

This review uses only:

- the complete original plan in `docs/plans/top-5-single-vt-closure/`;
- the current post-enabler implementation; and
- the exchange written in this directory.

Other plan directories and `research/` are excluded. The live source is
authoritative when the original plan describes code that the enablers changed.

## End-state contract

Shipctl is complete only when `libghostty-vt` in the backend is the sole VT
authority. The backend owns terminal meaning, revisions, ordering, history,
effects, selection, and mode-aware input encoding. Every Shipctl client consumes
versioned semantic state. The frontend keeps a renderer-independent cell model
and a presentation-only surface; it receives no child PTY bytes and parses no
ANSI or OSC. xterm, ANSI replay, raw-byte attachment paths, and the migration
switch are removed after parity is proved.

Routine resize, theme, focus, and visibility changes are ordered terminal or
presentation transitions, never recovery. Unbased recovery is limited to the
four original boundaries: initial attach, deliberate model loss, sequence or
base-revision mismatch, and queue overflow.

## Initial structural hypothesis

The first `ast-grep outline` pass indicates that the enablers changed the
starting point without delivering closure:

- `terminal/compat.rs` and `terminal/retention.rs` supply dependency and
  retention evidence, but there is not yet a production semantic projection;
- Rust `TerminalEvent` still exposes `Output` and `Replay`, with replay bytes;
- `TerminalAttachmentController` is DOM-free, but its ports still install ANSI
  replay and release numeric output bytes;
- `TerminalView` and the frontend renderer surface still depend on xterm; and
- the control socket and CLI still expose replay/raw-output adapters.

These are hypotheses until the focused source audit establishes the exact
remaining work.

## Twelve-round protocol

1. Establish the source boundary and completion contract.
2. Independent reviewer audits the live implementation with `ast-grep outline`.
3. Primary reviewer traces the production data and input paths.
4. Reconcile what the enablers completed versus what remains.
5. Propose exactly five end-state delivery areas and their dependency graph.
6. Challenge scope boundaries, especially transport, client model, and surface.
7. Review sequencing, stop conditions, and migration-switch discipline.
8. Draft the five plans against concrete modules and symbols.
9. Independently cross-review the drafts for missing capability or authority.
10. Apply corrections and recheck the live code references.
11. Audit acceptance criteria, validation, operability, and deletion proofs.
12. Jointly sign off the canonical five or record unresolved objections.

Each round must contribute a decision, correction, or proof. Restating an
accepted point does not count as a round.
