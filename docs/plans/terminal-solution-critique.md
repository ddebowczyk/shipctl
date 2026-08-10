The double VT parser is the main concern. No Beads items have been created yet.

Today, Ghostty parses PTY bytes in Rust, then xterm parses the same bytes again in the frontend. Recovery is not a cell snapshot: Ghostty formats terminal state back into ANSI bytes, and `TerminalView` resets xterm and asks it to parse those bytes again.

This creates unstable ownership:

- Resize can make Ghostty and xterm interpret adjacent bytes at different geometries.
- Theme and OSC palette state can diverge between the parsers.
- Each parser has its own reflow and scrollback behavior.
- Hide/show currently detaches and replays instead of preserving a durable attachment.
- xterm currently owns input encoding, OSC 9 notices, links, selection, and rendering. Removing it requires explicit replacements, not only a new renderer.

The `*-sol` ordered-event plan improves this, but it still preserves two emulators. Its xterm resize/palette barriers are a mitigation, not the destination. I will retain the useful parts—host-actor ordering, sequence/incarnation, recovery boundaries, and testable attachment state—but not build a permanent xterm barrier protocol.

The main reconciliation is this:

```text
PTY bytes
  -> TerminalRuntime + libghostty-vt       sole VT authority
  -> ScreenSnapshot / ScreenDelta          versioned cell-state contract
  -> DOM-free attachment state machine
  -> non-emulating TypeScript cell renderer
```

Therefore, “binary IPC” must change meaning. Raw PTY output must not become the long-term frontend protocol, since that forces a browser VT parser. The first task will stabilize and test PTY-byte ingress inside the host. A later binary protocol task will carry screen snapshots and deltas to TypeScript.

Other required early work:

- Extract the `TerminalView` attachment effect into a renderer-agnostic, DOM-free state machine. It must have deterministic tests for gaps, stale generations, snapshot boundaries, recovery, exit races, and registry reconciliation.
- Prove Ghostty can expose every needed cell fact: graphemes, wide cells, styles, hyperlinks, wrap state, cursor, modes, palette, primary/alternate screens, and scrollback.
- Resolve the retention issue before promising row-based history. The current Ghostty setting is named as lines but may be byte-based; the dependency ownership decision must be explicit.
- Move links, copy, search, selection, bells, OSC notifications, and semantic key/paste/mouse input to host-owned state or explicit renderer services before xterm removal.
- Keep hidden terminal state current without forcing paint work. Overflow must create one recovery boundary, never discard or replace PTY bytes.
- Verify the pinned Tauri desktop API for binary screen frames before committing to its codec.

If this interpretation matches your intent, I’ll create the dependency-ordered epic and tasks with PTY bytes first and test gates in every task.

<oai-mem-citation>
<citation_entries>
MEMORY.md:31-36|note=[terminal authority target and migration constraints]
rollout_summaries/2026-08-09T16-03-48-MzzX-shipctl_terminal_single_vt_authority_architecture.md:50-61|note=[prior source-verified target architecture]
</citation_entries>
<rollout_ids>
019fe744-1e38-7fe3-94bd-6f2e2e7d0801
</rollout_ids>
</oai-mem-citation>
