# Round 03 — primary production-path audit

## Output and recovery path

The live production path still has two VT authorities:

```text
PTY reader
  -> RuntimeActor::handle_output
  -> VtReplayEngine::feed (Ghostty parses)
  -> TerminalEvent::Output { Arc<[u8]> }
  -> Tauri Channel<TerminalEvent> / JSON numeric byte array
  -> decodeTerminalEvent
  -> TerminalAttachmentController::releaseOutput
  -> terminalOutputQueue
  -> xterm.write (xterm parses)
```

`RuntimeActor::resize` and `RuntimeActor::set_theme` still create
`TerminalEvent::Replay`; `VtReplayEngine::replay` calls
`format_active_screen`; and `TerminalView` handles replay by unregistering the
queue, calling `term.reset()`, resizing xterm, and feeding the ANSI replay.
Attach bootstraps through the same `TerminalReplay` byte model.

The enabler decoder validates that old model exhaustively. It does not make the
model semantic: `terminalEventContract.json`, Rust `contract.rs`, and
`terminalEventDecoder.ts` still describe output and replay byte arrays.

## Input path

xterm still performs browser-side mode interpretation and emits strings through
`term.onData`. `TerminalAttachmentController::submitInput` and
`TerminalClientRuntime::write` now give admission one tested path, but Tauri
still uses `Array.from(bytes)`, Rust accepts `Vec<u8>`, and `RuntimeActor::Write`
writes those bytes directly to the PTY. Ghostty's key, paste, mouse, and focus
encoders are only compatibility fixtures; they are not production input.

## Visibility and model lifetime

The controller extraction is a real seam, but continuity is not yet moved out
of React. `TerminalView` still:

- returns from the attachment effect while `visible` is false;
- includes `visible` in that effect's dependency list;
- disposes the controller on effect cleanup, which detaches; and
- catches up theme and settings on reveal because the attachment and surface
  lifetimes are still coupled.

There is no client cell model. The controller owns generation and sequence for
raw replay/output, while viewport, selection, scrollback, palette, and the
canonical visible buffer still live in xterm.

## Other production consumers

The control socket maps the same domain event to `TerminalControlEvent::Output`
and `Replay`, base64-encodes the bytes, and labels replay
`shipctl_vt_replay_v1`. `shipctl terminals attach --raw` decodes and writes both
forms directly to the caller's terminal. Global closure therefore includes the
control protocol and CLI; a webview-only cutover would leave Shipctl carrying
child PTY bytes and reconstructed ANSI.

## Enablers that should be extended, not redone

- `terminal/compat.rs` proves cells, wrap, colors, links, modes, encoders,
  effects, history, and selection can be copied from the pinned dependency. It
  also proves OSC 9 payload is still unavailable.
- `terminal/retention.rs` and `TerminalService` establish a byte policy for new
  runtimes and construction-only updates.
- `terminal/contract.rs`, `terminalEventDecoder.ts`, and bootstrap tests provide
  the exhaustive-adapter and fail-closed pattern.
- `TerminalAttachmentController` provides the DOM-free trace seam.
- `TerminalClientRuntime` now owns descriptor mutation and typed input/close
  outcomes.

The end-state plans must preserve these seams while replacing their raw-byte
payloads and xterm-specific ports.

## Structural cross-check

`ast-grep outline` identified the exact production owners above. TypeScript LSP
references show `TerminalAttachmentController` has one production consumer,
`TerminalView`, so its protocol can evolve without a broad UI call-site
migration. Rust LSP references place `TerminalEvent` production use in
`runtime.rs`, `commands.rs`, and `instance/control.rs`; the remaining references
are the contract and tests. This supports one host domain model with exhaustive
adapters rather than parallel transport-specific models.
