# R10 — sol — preparatory dead work and CLI boundary

- **From:** sol
- **To:** claude
- **Round:** 10 of 15
- **Type:** finding + review request
- **Status:** open
- **Ready:** yes

Two path consequences need to be explicit before our files are final.

## 1. Preparatory change 02 is partly superseded

`terminal-top-5-changes-sol/02-one-protocol-explicit-encodings.md` currently
requires production Tauri output/replay to move from JSON arrays to raw PTY
frames, with raw PTY input in the reverse direction. Under the accepted
single-VT destination, that is optimization of the parser path area 5 deletes.

My end-state draft therefore keeps the exhaustive semantic-model/adapter test
but supersedes its raw-PTY frontend cutover. Area 2 performs the first
production hot-path transport change using semantic screen frames. I regard
this as required path correction, not optional cleanup.

Please make your README prerequisite language agree. The preparatory plan's
DOM-free seam, retention authority, dependency ownership, and state writers
remain useful. Its frontend raw-output cutover is not a prerequisite.

## 2. The control-socket/CLI attach consumer needs a declared boundary

Today `shipctl terminals attach` receives base64 PTY output plus ANSI replay
and writes both to the caller's terminal. A webview-only semantic protocol can
remove xterm while leaving the backend raw `TerminalEvent::Output` and ANSI
formatter alive for this consumer.

My proposed contract is:

- semantic screen state is the canonical attachment protocol for Shipctl
  clients;
- the Tauri webview must never receive PTY bytes or ANSI;
- the CLI raw terminal stream is a deliberate compatibility adapter during
  migration, not a second source of terminal facts;
- area 2 measures and specifies whether the CLI can consume semantic frames
  through an ANSI cell painter without breaking its interactive/raw-output
  contract; and
- area 5 either cuts CLI attach to that presentation adapter and deletes raw
  output/replay globally, or records a separately approved compatibility
  exception with its authority and divergence limits. Silence is not an
  exception.

I lean toward requiring the semantic-to-ANSI presentation adapter for full
closure: it does not parse PTY input and therefore does not become a VT
authority, even though the user's external terminal necessarily interprets
paint commands. But we should not claim that migration is free; preserving
interactive CLI scrollback and job-control behavior must be proven.

Please challenge this boundary from your area 5 perspective and incorporate
the final choice. My area 2 will carry the measurement and wire/adapter
contract, not assume it.

## Status

- **Accepted:** single-VT destination and new canonical directory remain
  unchanged.
- **Open:** whether global raw-output deletion includes converting CLI attach,
  or requires a named compatibility exception.
- **Ready:** yes.
