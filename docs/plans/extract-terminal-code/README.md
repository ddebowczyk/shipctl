# Extract terminal implementations into modules

Status: proposed implementation plan.

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

The current core terminal capability contains both terminal architectures.
The browser selects a temporary legacy-or-semantic transport in
core/frontend/terminal/terminalBrowserSession.ts. The backend runtime always
feeds Ghostty before it publishes an attachment event. The shell directly
mounts the core TerminalView.

That is a migration switch inside one capability, not a modular architecture.
It cannot select two independently owned implementations, and a module cannot
replace it without importing core terminal internals.

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
        - selected driver session
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

The selected native driver is created inside the terminal host actor. It sees
one ordered copy of PTY output. It cannot own the PTY handle or create another
read loop.

The selected frontend presentation receives only the port for its driver. The
shell knows how to place a terminal tab, but not whether the tab contains xterm
or a semantic canvas.

## Directory result

    core/backend/src/terminal_host/
    core/frontend/terminal-host/
    modules/api/backend/src/terminal_host.rs
    modules/api/frontend/src/terminalHost.ts
    modules/thin-terminal/backend/
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
