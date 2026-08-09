# 02 — Host-owned terminal state: the root claim, elaborated

Verbatim transcript. 2026-08-09. Follow-up to `01-terminal-architecture-comparison.md`.

---

## Question

Elaborate: "fut's one structural decision (the host owns terminal state; clients are views) is the root that would dissolve four separate shipctl problems at once"

---

## Answer

## The mechanism

"Host owns terminal state" sounds like a layering preference. It's actually a claim about a channel type. In fut, screen state is a `watch::Sender<ScreenSnapshot>` and lifecycle is a `watch::Sender<TerminalLifecycle>` (`src/terminal/runtime.rs:77-85`). Watch semantics mean the channel holds a *current value*, not a backlog. So attaching is a read:

```rust
let screen = snapshots.borrow_and_update().clone();   // daemon/mod.rs:1016
```

That single line is the whole thing. A new consumer gets correct state immediately, with no replay, no catch-up window, no ordering problem, and no cost proportional to how long the terminal has been running. Detach is dropping a receiver. Ten consumers cost the same as one.

shipctl has no current value anywhere. `PtyOutput::Data` is a *stream* (`session.rs:124`), and a stream's only representation of "current" is "everything that ever happened, replayed in order." That's why `terminalOutputQueue.ts` has a 1 MiB pre-attach buffer that truncates from the front and prints `[output truncated while terminal was unavailable]` — that marker is the stream model admitting it cannot reconstruct current state.

## The split that follows

Once the host holds terminal state, a second boundary appears for free: what's *shared and authoritative* versus what's *per-viewer and disposable*.

fut puts viewport offset, snapshot revision, focus, layout, and copy-mode ownership in `Attachment` (`daemon/mod.rs:487-506`) — one per client, thrown away on detach. Copy mode is even keyed by `ClientId` inside the emulator itself (`ghostty.rs:110`, tested by `two_copy_owners_select_render_and_copy_independently`). Two clients can select different regions of the same terminal simultaneously.

shipctl has no such split, because there is only ever one viewer, so nothing forces the question. `pinnedToBottomRef` (`TerminalView.tsx:60`) is view state; `stoppingPtys` (`usePty.ts:36`) is authoritative lifecycle state; both live in the same module-level scope in the same renderer, indistinguishable.

## The four problems, traced

**1 & 2 — no CLI inspection, and reload orphans processes** — are the same problem viewed from either end. The consumer is fixed at spawn (`session.rs:523`), so there is exactly one, it lives in the renderer, and it cannot be replaced. A CLI can't become a second consumer; a reloaded webview can't become the same one again. When it dies, `run_output_coalescer` returns without calling `on_completion` (`session.rs:187-191`) and the process is unreachable but alive.

**3 — no second viewer** is the general case. The workaround exists and shows the shape of the constraint: `hostTerminalOutputListeners` (`usePty.ts:46`) is a fan-out registry — the right idea, implemented in JavaScript, on the wrong side of the boundary, so it only serves consumers already inside the webview.

**4 — the state-sync sprawl** is the least obvious and the most expensive, so it's worth tracing carefully.

Client authority doesn't merely *misplace* facts. It **splits single facts across the IPC boundary**, and every split fact then needs a correlation protocol.

Take "was this exit requested?" The frontend owns the intent; the backend owns the process death. They arrive independently and in nondeterministic order. So shipctl builds a correlator: add to `stoppingPtys` before calling `killPty`, delete on failure, then at exit time `const stoppedByUser = stoppingPtys.delete(ptyId)` (`usePty.ts:166`). Then, because that correlation can still lose, three more guards on `owned.state === "exited"` (`usePty.ts:78-81`, `usePty.ts:492`) to stop double-publishing exits. Six module-level maps in `usePty.ts` are not accidental sprawl — they are the protocol that client authority requires.

In fut the fact isn't split. Requested-versus-natural is `CloseCause::{Requested, TerminalExited}` (`resources.rs:161`), decided on one side of one boundary. Process death is the `lifecycle` watch — one authoritative value. Closing an already-dead terminal is `Ok` because `normalize_close_result` (`runtime.rs:295`) can just *read* the lifecycle value and see it exited. Idempotent close isn't defensive code; it's a consequence of the fact existing in one place.

So: recommendation C in my earlier report isn't independent of the root. It's the root's tax, paid in a different currency.

## What it does not buy, and the decision people conflate

Two separate decisions get bundled under "fut has a daemon":

- **Host owns terminal state** — in-process, and the one doing the work above.
- **The host is a separate long-lived process** — what gives fut survival across client *crash*, and lets one daemon span all projects.

shipctl adopting the first does not get the second. PTYs remain children of the Tauri app; app restart still kills every terminal. The win is webview reload, second windows, host-level observers, and CLI access — not crash survival. Getting crash survival means moving PTY ownership out of the app process entirely, which is a genuinely large change with a different payoff, and I wouldn't bundle it in.

## The asymmetry that makes this cheap for shipctl

fut pays a high price for host-side state — `PERF.md` is blunt about it: full-grid rebuild per 1 KiB, 100–300 KiB JSON per frame per client. But fut pays that **because its client renders from the host's state**. Every frame the human sees is a snapshot crossing a socket.

shipctl's human UI renders from bytes in xterm.js and would keep doing so. Only *agents* would read host state, and agents query occasionally, not at 60fps. So the cost model is per-query, not per-frame — which lets shipctl use a design fut structurally could not.

That suggests a ladder rather than a leap:

1. **Bounded byte ring per terminal + fan-out sink.** Fixes 2 and 3 outright and makes close idempotent at the host, which retires most of 4. No emulator.
2. **Typed lifecycle and agent state in the host** (recommendation A). Answers "which sessions are blocked" from the CLI without any screen representation.
3. **VT parse on demand** — feed the ring through a headless parser only when someone calls `shipctl terminal read <id>`. Cost proportional to ring size per query, not to output volume continuously.

Step 3 is where I'd push back on my own earlier framing. I called host VT state "a fair price not to pay." For log-style output that holds. But the terminals shipctl exists to supervise are *repainting TUIs* — Claude Code, Codex, and friends redraw in place. Tail their raw bytes and an agent gets cursor moves, clears, and partial redraws, not content. If `shipctl terminal read` is meant to answer "what is this agent showing the user right now," bytes cannot answer it and a VT parser is not a luxury — it's the literal requirement of the product premise. The good news is that step 3 buys it at query cost, which is roughly two orders of magnitude cheaper than the way fut had to buy it.
