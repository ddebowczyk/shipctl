# Shipctl terminal single-VT end-state

## Executive summary

Shipctl must finish with one terminal authority. `libghostty-vt` in the backend
will be the only component that parses child PTY output, decides terminal cell
occupancy and modes, retains history, and encodes mode-aware PTY input. Every
Shipctl client will consume versioned semantic state and submit semantic
commands. The webview and CLI will present that state without receiving or
parsing the child's VT stream.

The implemented enablers made this migration testable and reduced its risk, but
they did not move the production authority boundary. Today Ghostty parses PTY
output and Shipctl then forwards the same output, or a reconstructed ANSI
replay, to xterm. xterm parses it again and remains the browser's buffer,
history, width, mode, selection, and input authority. That duplicated authority
is the root cause of cursor, reflow, replay, visibility, and recovery tripwires.

[`00-drive-assessment.md`](00-drive-assessment.md) answers how to drive the work:
what the enablers left, where the remaining risk is, and the order to start in.
The five plans below close one authority boundary each:

1. [Host semantic authority is production](01-host-semantic-authority-is-production.md)
2. [Semantic protocol reaches every client](02-semantic-protocol-reaches-every-client.md)
3. [Client model owns terminal continuity](03-client-model-owns-terminal-continuity.md)
4. [Presentation surface achieves parity](04-presentation-surface-achieves-parity.md)
5. [Cutover deletes the second VT](05-cutover-deletes-the-second-vt.md)

Completion means the legacy parser path and its migration switch are deleted,
not merely disabled by default.

## Current production path

```text
child PTY bytes
  -> RuntimeActor::handle_output
  -> VtReplayEngine::feed              Ghostty parses
  -> TerminalEvent::Output or Replay
  -> Tauri JSON bytes / control base64
  -> TerminalAttachmentController
  -> terminalOutputQueue
  -> xterm.write or term.reset          xterm parses again
```

The duplicated path appears in all product clients:

- the webview receives numeric byte arrays through the Tauri channel;
- the control socket base64-encodes raw output and replay ANSI; and
- `shipctl terminals attach --raw` decodes those bytes and writes them to the
  caller's terminal.

Resize and theme changes are also reconstruction events today. The runtime
formats Ghostty state back into ANSI, publishes a replay, and the webview resets
xterm. Visibility is coupled to attachment lifetime, so hiding a surface can
dispose the protocol controller instead of merely suppressing paint work.

## Target production path

```text
child PTY bytes
  -> RuntimeActor
  -> Ghostty terminal state             sole VT authority
  -> Shipctl-owned semantic projection
  -> versioned snapshot/delta/effects
  -> renderer-independent client model
  -> webview cell painter / CLI painter  presentation only

browser or CLI gesture
  -> semantic command
  -> RuntimeActor + Ghostty mode state
  -> host-encoded PTY input
  -> child PTY
```

The target has four intentional recovery boundaries:

1. initial attachment;
2. deliberate loss or recreation of the client model;
3. sequence or base-revision mismatch; and
4. queue overflow.

Resize, theme, focus, visibility, and surface recreation are ordered state or
presentation transitions. They are not reasons to discard the client model or
request an unbased reconstruction.

## Enablers already implemented

The plans extend these seams rather than rebuilding them:

- `core/backend/src/terminal/compat.rs` proves the pinned Ghostty API can expose
  cells, history, styles, wrap, cursor, modes, palette, links, prompts,
  selection, effects, and input encoders as owned Rust facts. It also proves the
  remaining OSC 9 payload gap.
- `core/backend/src/terminal/retention.rs` and `TerminalService` establish one
  measured, byte-based, construction-only retention authority.
- `core/backend/src/terminal/contract.rs`, the checked-in event contract, and
  `terminalEventDecoder.ts` provide an exhaustive, fail-closed cross-language
  contract pattern. The current schema still describes raw output and replay.
- `TerminalAttachmentController` provides a DOM-free sequence, generation, and
  recovery seam with deterministic trace tests. Its current ports still carry
  bytes and replay.
- `TerminalClientRuntime` owns descriptor reduction, tombstones, and typed
  write and close outcomes, preserving one writer for terminal registry state.

These are regression gates. Retention is not reopened as a line-count feature,
the controller is evolved rather than replaced, and no parallel event schema or
registry writer is introduced.

## Delivery and acceptance order

```text
01 host semantics
  -> 02 semantic protocol and adapters
  -> 03 persistent client model
  -> 04 presentation parity
  -> 05 coordinated cutover and deletion
```

This is an authority acceptance order, not a requirement for five monolithic
pull requests or strictly serial staffing.

**It is not a start order.** It says which proof must exist before another proof
counts. Risk and dependency do not point the same way here: read as a start
order it puts the only surviving unknown last.
[`00-drive-assessment.md`](00-drive-assessment.md) derives the execution order
from what the enablers measurably left in the tree, and it begins with an actor
harness that is in none of the five areas. Read it before staffing them. The
acceptance order below is unchanged by it.

- Area 04 begins its capability register, Unicode rendering probe, IME and
  accessibility probes, and CLI painter probe while area 01 progresses.
- Area 02 may benchmark representative semantic fixtures before area 01 is
  complete, but cannot freeze the effect union before the OSC 9 disposition.
- Area 03 may develop deterministic traces against decoded fixtures before the
  production transport lands.
- Area 05 owns the sole migration switch and comparison telemetry from their
  introduction, but cannot change the default until areas 01-04 pass.

The webview presentation path consumes area 03. The CLI painter consumes area
02 directly. Both must pass area 04 before global cutover.

## Non-negotiable authority rules

- Host-provided cell occupancy is the only Unicode column-width authority.
  Frontend font measurement may place glyphs inside supplied spans but cannot
  change columns, wrap, cursor placement, selection, or reflow.
- The webview cannot submit arbitrary PTY bytes. Key, composed text, paste,
  mouse, focus, selection, and application actions are semantic commands that
  the host encodes using current terminal modes.
- Client occurrence effects such as bell, notification, clipboard, and exit
  remain ordered with cell mutations and cannot disappear through coalescing.
- Parser-generated PTY replies remain ordered actor-to-child work. They never
  enter the semantic client protocol or any Tauri, control, or CLI stream.
- Control-socket base64 is allowed only as an encoding of semantic payloads.
  It may never contain child output or replay ANSI.
- The CLI may generate ANSI locally to paint semantic cells in the caller's
  terminal. That output is presentation and never becomes Shipctl state.
- No transport, surface, or client may create a private migration switch.
- No plan may invent a frame size, batching interval, timeout, retry, soak,
  sample count, or performance threshold. Each limit must cite a technical
  contract, product requirement, or recorded measurement.

## Owner decisions that can stop the program

The work stops for an explicit decision instead of retaining hidden dual
authority when:

- Ghostty cannot expose a required semantic fact, input mode, selection
  operation, or ordered effect;
- OSC 9 cannot be delivered through owned dependency support or a bounded,
  non-state-mutating host effect extractor, and removal is not approved;
- the replacement surface cannot meet a required rendering, input, IME,
  accessibility, fallback, or measured performance capability;
- host-defined Unicode spans cannot be presented without changing occupancy;
  or
- an approved CLI or control contract requires literal child-byte identity.

An approved capability removal must update the product contract before its area
passes. Silence or a permanent fallback is not approval.

## Global completion proof

The refactor is complete only when all of the following are true:

- fixed PTY traces produce fixed semantic state through the production host;
- fixed semantic state produces fixed presentation facts independently of the
  host fixtures;
- snapshots plus valid deltas reconstruct the same model as complete snapshots;
- production Tauri, control-socket, webview, and CLI paths use the same semantic
  domain exhaustively and reject malformed or unsupported frames atomically;
- packaged-product scenarios cover resize, theme, focus, hidden output,
  history, alternate screen, links, selection, copy and paste, mouse modes,
  Unicode clusters, IME, effects, gaps, recovery, recreation, and close races;
- raw output, replay ANSI, xterm, the byte queue, and the migration switch are
  removed; and
- durable negative checks prove that no Shipctl transport carries child output
  or replay ANSI and no frontend VT or width authority can return.

Backend PTY ingress and host-encoded PTY input remain valid internal byte
boundaries. Locally generated CLI presentation ANSI also remains valid. The
negative gates distinguish those necessities by type and provenance instead of
using blanket text bans.
