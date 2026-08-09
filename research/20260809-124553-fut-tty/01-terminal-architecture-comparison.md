# 01 — What shipctl can learn from fut about terminal handling

Verbatim transcript. 2026-08-09.

---

## Question

identify if we can learn anything from fut to improve shipctl terminal handling - simplify, make more robust, make cleaner, reduce complexity, make it more extendable

About shipctl - agent operated workspace for human coordinators of agent swarms working in multiple projects, multiple terminals, multiple agent sessions; shipctl is cli for agent driven inspection and ops + Tauri UI workspace for human to work with agent sessions, terminals, etc.

Check ~/projects/_agents/fut/
Check shipctl code in the current repo

Use `ast-grep outline`, ripgrep, ix, qmd if you need to scan the codebase.
---
This is Fut, a modern, agent-aware terminal multiplexer—roughly “tmux rebuilt around projects, worktrees, and coding agents.”

  one Fut daemon
  └── session      live project
      └── workspace  checkout or working context
          └── tab    activity
              └── pane  terminal placement
                  └── terminal/process

  The important distinction is that Fut runs one user-level daemon across all projects. Clients can detach while shells and agents continue running, and each client retains independent focus, viewport, navigation, and
  notification state.

  ### What is already implemented

  Version 0.2.0 currently provides:

  - Persistent PTY sessions with detach/reattach.
  - Multiple projects and Git worktrees in one daemon.
  - Tabs, split panes, pane movement, zoom, navigation history, sidebar, tab bar, jump dialog, and command palette.
  - Ghostty-based terminal parsing with Ratatui rendering.
  - Mouse input, scrollback, search, copy mode, bracketed paste, and macOS clipboard integration.
  - A typed CLI and MessagePack client/daemon protocol.
  - Versioned JSON responses and UUID-addressed operations for automation.
  - Agent lifecycle reporting: idle, working, blocked, and completed.
  - Per-client unseen-completion navigation and a first-party Pi extension.
  - Performance tooling for noisy terminals and dense styled output.

  Bare fut opens the current directory, starts/discovers the daemon, creates the required resource hierarchy, and attaches interactively.

  ### Implementation map

  The AST outline shows four main cores:

  - src/resources.rs:315 — authoritative resource tree and lifecycle invariants.
  - src/daemon/mod.rs:1097 — socket server, PTY ownership, attachments, resource mutations, and reconciliation.
  - src/client/mod.rs:143 — interactive Ratatui client, per-client state, input, layout, and rendering.
  - src/terminal/runtime.rs:472 and src/terminal/ghostty.rs:126 — PTY execution and terminal-state emulation.

  Supporting boundaries:

  - src/cli.rs:19 — human and agent-facing command surface.
  - src/protocol.rs:106 — typed client/server messages.
  - src/domain.rs:268 — terminal cells, snapshots, mouse events, and agent state.
  - src/project.rs:1 — Git/common-directory and ordinary-directory project identity.
  - src/splits.rs:1 — persistent authored split topology.
  - integrations/pi/fut.ts:1 — Pi lifecycle reporting.

  The heaviest files are the daemon, client, resource tree, terminal adapter, and an unusually comprehensive ~9,000-line end-to-end test suite.

  ### Product direction versus current state

  The clearest product definition is VISION.md:3. The implementation is already well beyond a prototype, but several envisioned areas remain deferred:

  - Project-local startup recipes and trust management.
  - Generic integration plumbing beyond Pi.
  - Process/screen heuristics for detecting agent activity.
  - Terminal-native alerts such as BEL or silence detection.
  - Linux hardening and broader platform support.
  - Remote attach and native graphical clients.

  The current supported product is macOS-first and terminal-within-a-terminal; it is not trying to become a full agent orchestrator or GPU terminal emulator.

  The Ix guidance was useful for choosing a graph-first orientation workflow, but the local Ix backend at localhost:8090 is currently unreachable, and ix doctor reports no accessible nodes or edges. I therefore used
  ast-grep outline plus ripgrep and did not create or refresh an Ix map. The worktree remains clean and unchanged.

---

## Answer

## BLUF

Yes — and the useful learnings are not "port fut's architecture." fut's one structural decision (**the host owns terminal state; clients are views**) is the root that would dissolve four separate shipctl problems at once. Its *wire format* (full-grid snapshots) is the part you should explicitly not copy — fut's own `PERF.md` shows it costing ~500µs and 100–300 KiB per frame per client.

Along the way I found three real defects in the current PTY path. Those first.

---

## Defects found while reading

**1. Closing one terminal stalls every other terminal for up to 3s.**
`PtyManager::kill` (`core/backend/src/terminal/manager.rs:149-156`) holds the `sessions` mutex across `session.kill()` → `kill_until(now + 3s)` (`session.rs:738-744`), which sleeps in 50ms increments. `write`, `resize`, and `acknowledge_output` all take that same lock (`manager.rs:114,122,141`). So closing one agent tab freezes input and — worse — flow-control acks for every other terminal, which parks their reader threads at the high watermark. Fix is one line of scoping: `remove` from the map, drop the guard, then kill.

**2. A dead output channel leaks the session and its process tree.**
`run_output_coalescer` returns early when `dispatch_output` fails without calling `on_completion` (`session.rs:187-191`). The entry stays in `PtyManager.sessions` forever, the child keeps running, and the reader thread blocks indefinitely in `child.wait()` (`session.rs:659`). This is exactly the reload-orphan path your own `docs/plans/20260808-072927-ext-plus-thin-core/feedback-round-2/02-resource-ownership-and-pty.md` identified and deferred.

**3. Every blank terminal nests two login shells.**
`spawnBlankShell` passes `` `${shell} -l` `` as the *command* (`usePty.ts:439`), and the backend already wraps everything in `$SHELL -l -i -c` (`session.rs:536-550`). Result: `zsh -l -i -c "zsh -l"` — the profile runs twice per terminal.

---

## The structural difference

In shipctl, the webview creates the `Channel<PtyOutput>` and it is baked into `PtySession` at spawn (`terminal/commands.rs`, `session.rs:523`). One PTY has exactly one consumer, fixed for life, living in the renderer. Everything downstream follows from that:

- **The CLI has no terminal surface at all.** `rg -i 'terminal|pty' cli/src/` returns nothing; `ControlOperation` (`instance/protocol.rs:230`) has Modules, Messages, Capabilities, Schedules, Operations — and no Terminals. For a product whose CLI *is* the agent's inspection surface, agent sessions are the one thing agents can't inspect.
- **Reload orphans processes** (defect 2).
- **No second viewer** — second window, host-level module observer, or headless reader. The module observer hook exists, but bolted on in JS as `hostTerminalOutputListeners` (`usePty.ts:46`).

fut's equivalent is `TerminalHandle` (`src/terminal/runtime.rs:77`): the daemon owns it, and consumers attach via `subscribe_snapshots` / `subscribe_events` / `subscribe_lifecycle`. N consumers, attach and detach freely, none of them authoritative.

You don't need a daemon to get most of this. You need the output sink to be a *fan-out registry keyed by terminal id* plus a bounded ring of recent bytes, with the Tauri `Channel` demoted to one re-bindable subscriber.

---

## Ranked, with honest cost

**A. Reported agent state instead of inferred.** *(highest value / lowest cost — do this regardless of A-through-E)*

shipctl infers agent state from a 3-second output-silence timer (`usePty.ts:33-35,143-149`) plus OSC 9 and BEL (`TerminalView.tsx:108-119`). fut has a typed `AgentReport {Idle,Working,Blocked,Completed}` (`src/domain.rs:277`) pushed *by the agent* via `fut terminal report <state>` (`src/cli.rs:257-278`), stored on the pane with a `revision` and `AgentAttention {revision, kind, occurred_at_ms}` (`domain.rs:292-306`), plus per-client unseen-completion navigation. The whole Pi integration is 26 lines (`integrations/pi/fut.ts`).

"Which of my 20 sessions is blocked on me right now" is a first-class query in fut and a heuristic in shipctl. You already have the transport: `PtyManager` injects `SHIPCTL_INSTANCE_ID` into every PTY env (`manager.rs:107-112`). Add `SHIPCTL_TERMINAL_ID` + a `shipctl terminal report` control operation and you get the same thing without touching the output path.

**B. Host-owned terminal registry + `shipctl terminal {list,tail,write}`.** This is A's structural counterpart and the thing that makes shipctl's own CLI premise true. Cheap version: bounded raw-byte ring per session (no emulator), fan-out sink, host-minted ids. Fixes defect 2 as a side effect.

**C. One authoritative tree, two-phase close.** shipctl currently has three sources of truth — Zustand `projectState`, Rust `PtyManager.sessions`, and six module-level maps in `usePty.ts` (`hostTerminalSessions`, `hostTerminalSessionIdsByPty`, `hostTerminalOutputListeners`, `stoppingPtys`, `activityTimers`, `activityActive`). The cost is visible in the code: `completeHostTerminalSession`'s requestedStop/state dance (`usePty.ts:65-91`), the "owner already got its exit" special case (`usePty.ts:490-495`), `stoppingPtys.delete` on catch. fut has one `ResourceTree` (`src/resources.rs:315`) returning `Mutation { revision, events, terminals_to_close, multiplexer_empty }`, with an explicit `closing` flag, `cancel_close_*` rollback, a `validate()` invariant checker, and ~40 invariant tests. Clients hold no authority at all.

**D. One id space.** `tab-N` (frontend counter, `useTerminalStore.ts:51-54`), `ptyId: u32` (backend counter, `manager.rs:75-80`), `terminal-session-N` (frontend counter, `usePty.ts:50`). Three spaces, all reset on reload, ownership split across the IPC boundary. fut mints opaque typed UUIDs per level and addresses everything by them, including from the CLI. Just making terminal id a host-minted UUID that the other two reference deletes most of the mapping code in C.

**E. Drop the `pgrep` tree walk.** `get_all_descendants` (`session.rs:489-512`) spawns `pgrep -P` once per process, recursively, then signals pid + descendants + killpg. fut's `kill_terminal_processes` (`runtime.rs:1100`) reads `master.process_group_leader()` and `getpgid(child_pid)` and signals two groups — no subprocess, no walk/signal race, no `pgrep` dependency. Strictly smaller and more robust. Small, self-contained, do it with defect 1.

---

## What not to copy

**The snapshot pipeline.** fut's `PERF.md` is candid: a full-grid rebuild per 1 KiB of PTY output (629µs → 498µs after optimization), 100–300 KiB of JSON per frame *per client*, and they needed revision coalescing plus an 8ms min interval to get a styled flood from 0.61s to 0.30s. shipctl's raw-bytes-to-xterm.js path is cheaper per byte and already has the right primitives: the 5ms coalesce window (`session.rs:24`), 64 KiB chunked writes with surrogate-pair safety (`terminalOutputQueue.ts:135-158`), and byte-accurate ack-driven flow control (`session.rs:44-93`). Keep all of it.

One consequence worth noting but not acting on yet: because there's no host VT state, shipctl hand-rolls a *stateless partial* escape-sequence scanner in the reader thread to answer OSC 10/11/4 and CSI ?2031/?996 (`session.rs:264-440`), with a 4 KiB unterminated-sequence cap and a trailing-ESC hold. fut answers those from real terminal state. That ~180 lines is the price of not having host VT state — currently a fair price. It only becomes worth revisiting if inspection ever needs *rendered screens* rather than raw scrollback.

---

## Suggested sequence

1. Defects 1 and 3 + recommendation E — small, independent, no design decisions.
2. Recommendation A — high product leverage, uses transport you already have.
3. Recommendations B/D together — the reload-safety and CLI-inspection payload; this is where your deferred doc-02 decision comes due.
4. Recommendation C — falls out cheaply once B and D land.

Want me to write this up as a dated note under `research/` per your docs convention, or open bd issues for the three defects?
