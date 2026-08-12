# Extract terminal implementations into modules

Status: implementation complete; packaged-app comparison and product selection remain.

## Implementation status — 2026-08-11

The shared driver contracts, generic `TerminalSlot`, build-installed semantic
module, and thin-terminal package are present. Core owns the PTY, lifecycle,
raw ordered attachment, physical resize, terminal chrome, and driver
selection. It no longer imports the semantic module, Ghostty, or xterm.

`modules/semantic-terminal` owns the Ghostty parser, semantic state and input,
semantic attachment protocol, Tauri command namespace, canvas presentation,
fixtures, and tests. `modules/thin-terminal` owns xterm and its raw-byte
presentation. `TerminalTransport`, typed semantic compatibility protocol,
compatibility re-exports, and the old core terminal directories are deleted.

`modules/semantic-terminal/host/` is the sole composition adapter. It registers
the module's native driver and connects the module's host port to the generic
core `TerminalService`; the Tauri shell calls its public functions but contains
no semantic terminal behavior.
The root registers `thin-terminal` as the browser-only driver. A terminal's
selected `driverId` is fixed when its PTY starts.

Verification on 2026-08-11: `just test fast`, `just check all`, and
`cargo test --workspace` pass. The focused host, semantic, and thin frontend
suites also pass. The driver registry test resolves both drivers at once, and
the New Session menu creates either **Semantic terminal** or **TTY terminal**.

Remaining work is intentional product work, not extraction work: perform the
manual packaged-app exercises listed in 03-verification-and-cutover.md and
make an explicit owner decision on the default implementation.

## Contract

Shipctl will support two removable terminal implementations:

- thin-terminal: the host owns a PTY and forwards its byte stream unchanged to
  a browser terminal component. A Rust observer may emit selected sideband
  facts, but it does not render, reflow, retain terminal state, or write parser
  replies to the PTY.
- semantic-terminal: a module owns the Ghostty terminal interpreter, semantic
  state, semantic input encoding, and the semantic webview presentation.

Core will retain the small terminal host that is not an implementation:

- PTY creation, process lifetime, raw reads and writes;
- terminal identity, metadata, lifecycle, tab identity, and module-session
  adoption;
- physical PTY resize;
- one ordered, byte-preserving attachment path; and
- selection of one installed terminal implementation for a newly created
  session.

One live terminal has one selected implementation. It does not switch while
the PTY is alive. This prevents two parsers, two input encoders, or two resize
authorities from acting on the same session.

This is an extraction and experiment plan. It does not choose thin-terminal or
semantic-terminal as the product default. The current semantic behaviour stays
available while the two implementations are compared.

## Why the boundary changes

Before extraction, the core terminal capability contained most semantic work.
The browser bound one semantic presentation, the backend fed Ghostty before it
published attachment events, and selection could not name independent
implementations.

The extracted architecture replaces that migration switch with two module
implementations and a generic host. Modules select a driver at launch without
importing core implementation internals.

The existing performance evidence remains useful. It shows that the original
semantic cell-object protocol amplified the wire cost, and that compact runs
and reader-paced publication changed that result. It does not prove that a
semantic terminal must be the only implementation. See:

- ../top-5-end-state/perf-insights-20260811-111127.md
- ../../../research/notes/terminal-semantic-path-profile-20260811-1053.md

The single-VT claim in ../top-5-end-state/README.md conflicts with this
experiment only where it says Ghostty is globally the only authority and raw
bytes must be removed. During this plan, the invariant is instead one
authority per terminal session:

- thin-terminal: its browser terminal component is the authority for terminal
  interpretation and rendering;
- semantic-terminal: its Ghostty module is the authority; and
- core: never interprets terminal control sequences.

Before implementation starts, record this replacement of the global authority
decision in the affected end-state documents. Do not silently leave two
contradictory target architectures.

## Target shape

    child process
        |
        v
    core/backend/terminal_host
        - PTY, process, raw bytes, identity, physical resize
        - selected native driver session, when one is needed
        |
        +-- raw attachment --> modules/thin-terminal/frontend --> xterm
        |
        +-- driver bytes --> semantic-terminal backend --> semantic events
                                                   |
                                                   v
                                  semantic-terminal frontend --> canvas surface

    core/frontend/terminal-host
        - terminal tabs, module-session adoption, generic TerminalSlot
        - provider registry and selection

    modules/api
        - data-only host and driver contracts shared by core and modules

When the selected implementation needs native interpretation, its driver is
created inside the terminal host actor. It sees one ordered copy of PTY output.
It cannot own the PTY handle or create another read loop.

The selected frontend presentation receives only the port for its driver. The
shell knows how to place a terminal tab, but not whether the tab contains xterm
or a semantic canvas.

## Directory result

    core/backend/src/terminal_host/
    core/frontend/terminal-host/
    modules/api/backend/src/terminal_host.rs
    modules/api/frontend/src/terminalHost.ts
    modules/thin-terminal/frontend/
    modules/semantic-terminal/backend/
    modules/semantic-terminal/frontend/

Rust uses terminal_host because Rust module names cannot contain a hyphen.
The frontend package uses terminal-host so its public import is clearly a host
boundary. The old core/frontend/terminal and core/backend/src/terminal
directories are deleted at the end of the extraction, rather than retained as
compatibility exports.

## Non-negotiable rules

- The raw stream is a dedicated ordered terminal attachment. It never uses the
  general message bus. A Tauri envelope may encode bytes for IPC, but the
  concatenated byte sequence received by thin-terminal must equal the PTY byte
  sequence in order.
- Core applies a resize to the PTY through MasterPty::resize. That is physical
  host work. A semantic driver may resize its own model after that succeeds.
  A thin driver has no host terminal model to resize.
- Only the selected presentation may send terminal input and request physical
  resize for an attached terminal. The host serialises both operations in its
  actor.
- A thin Rust observer can report facts such as a bell, title, activity, or
  process exit. It cannot generate PTY replies, alter bytes, retain a screen,
  decide wrapping, or supply a render frame.
- Semantic screen, history, selection, anchors, and semantic input are
  semantic-terminal data. They do not appear in the core host contract.
- Raw history and shared late-attach guarantees are not implied by thin mode.
  Providing them would require a terminal-state server or an existing
  multiplexer, neither of which this plan creates.
- A module may depend on modules/api but never on another terminal module or a
  core implementation directory. Core may depend on modules/api but never on
  a terminal module implementation.

## What remains in core

Moving terminal code out of core does not mean moving the PTY out of the host.
The host must remain the operating-system owner of the child process, the
single physical size authority, and the source of terminal lifecycle facts.
Those responsibilities also let existing modules launch a terminal without
knowing which renderer will present it.

The extraction is successful when core has this narrow host code only. It is
not successful if xterm or Ghostty merely moves behind a core wrapper.

## Plan documents

1. 01-boundaries-and-contracts.md defines ownership, contracts, and dependency
   direction.
2. 02-execution-steps.md gives the ordered source migration.
3. 03-verification-and-cutover.md defines the proof, comparison, and final
   deletion conditions.

## Explicitly out of scope

- Runtime loading of a rich terminal UI artifact. The current artifact loader
  admits headless modules only. This plan uses the existing build-installed
  module mechanism and feature-gated Tauri plugins.
- A general remote terminal multiplexer, shared cross-client terminal state,
  collaborative selection, or exact late attachment in thin mode.
- A new generic message-bus stream for terminal bytes.
- A product choice between thin-terminal and semantic-terminal before
  side-by-side evidence exists.
- A visual redesign of terminal tabs, session ownership, or project actions.
