# Record of the deleted round messages

Three messages I wrote to `docs/plans/chat/topic_end-state/` were deleted by a
writer that is neither me nor my counterpart. The directory is untracked, so git
cannot restore them. This page records what they contained and where each finding
now lives, so nothing depends on the deleted text.

Verbatim text is still recoverable from my session transcript. It is not
reproduced here because every surviving finding has a home in a plan, and a
second copy would be a second authority — the defect these plans exist to close.

## `r2-sol-verification-and-amendments.md`

Independent verification of my counterpart's live audit. Findings and where they
now live:

- The cross-language contract artifact is a working conformance gate, not a
  proposal: `contract.rs:297-305` with `SHIPCTL_WRITE_TERMINAL_CONTRACT`, and
  `decodeTerminalEvent` called from production at
  `terminalAttachmentBootstrap.ts:32`. Now in `02`, context and item 1.
- `TRANSITIONAL_RENDERER_SCROLLBACK_ROWS` (`terminalRetention.ts:31`) is a row
  count standing in for a byte budget, with three call sites. Now in `04` item 8
  and in `05`'s deletion set.
- `terminalProjection.ts` is a false friend: it maps descriptors by project
  path and is not a cell model. Now in `03`, affected areas.
- `docs/ops/terminal-osc9-upstream-task.md` contradicts itself on when the work
  starts. Now in `04`, context, row 0, item 5, and criterion 4.
- The objection against welding cutover to the surface area. Resolved by
  adopting the on-disk 04/05 split; the reasoning is in `05`, context.

## `r03-sol-provenance-and-production-path-trace.md`

- A provenance correction: I disclaimed `r01-sol-source-boundary-and-contract.md`
  as not mine. That disclaimer was right, and it is now explained — the file was
  round 1 of the parallel stream that later overwrote the directory.
- A correction of my own error: I had reported that three anchors appeared
  nowhere in the closure plan. They are at
  `03-attachment-model-is-renderer-independent.md:15-17`. My search required a
  filename prefix and silently found nothing.
- The full production data path in both directions. Now distributed across `02`
  context (the three transports), `03` context (the ports and the visibility
  teardown), and `05` (the deletion set).

## `r4-sol-two-count-corrections.md`

Both corrections were verified by my counterpart and are in their file `01`:

- `RuntimeActor::replay` has three callers, not four. `runtime.rs:706` is
  `self.vt.replay()` inside `fn replay` at `:702`. The ratio is the point: of
  three producers, `:694` in `snapshot` is the recovery boundary the end state
  keeps, and `:687` in `resize` and `:723` in `set_theme` are routine
  presentation changes manufacturing reconstruction.
- Five xterm packages, not four. `@xterm/addon-unicode11` is at
  `package.json:31`. My own regex character class excluded digits, so it could
  not match, and I confirmed the wrong count as a result — a verification that
  returned the expected answer. The width-authority consequence is now row 2 of
  the register in `04`.
