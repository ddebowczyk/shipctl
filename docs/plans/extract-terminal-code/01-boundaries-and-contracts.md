# Boundaries and contracts

## Current map

The current terminal capability combines host, thin, and semantic work in
core. The extraction must split responsibility, not move files by name.

- Host process and record
  - Current: process.rs, TerminalRecord, and process lifetime in runtime.rs.
  - Destination: core/backend/src/terminal_host.
  - Reason: the host owns the child process, PTY, identity, metadata, and
    lifecycle. None depend on a renderer.
- Physical output and resize
  - Current: TerminalGeometry, PTY writer, raw output reader, and attachment
    fan-out.
  - Destination: core/backend/src/terminal_host.
  - Reason: a child has one physical size and one ordered writer. Both
    thin-terminal and semantic-terminal need one ordered input source.
- Mixed backend files
  - Current: runtime.rs, service.rs, commands.rs, publication.rs, and types.rs.
  - Destination: split by responsibility.
  - Reason: each currently mixes PTY ownership with Ghostty projection and
    transport variants.
- Semantic native implementation
  - Current: replay.rs, projection.rs, painter.rs, wire.rs, semantic input,
    semantic effects, contracts, and fixtures.
  - Destination: modules/semantic-terminal/backend.
  - Reason: these define semantic terminal state and input authority.
- Ghostty dependency
  - Current: libghostty-vt in core/backend/Cargo.toml.
  - Destination: modules/semantic-terminal/backend/Cargo.toml.
  - Reason: core must not select a terminal parser.
- Thin frontend implementation
  - Current: terminalXtermSurface.ts, terminalOutputQueue.ts, xterm renderer
    add-ons, and xterm viewport work.
  - Destination: modules/thin-terminal/frontend.
  - Reason: these parse and display the raw byte stream in xterm.
- xterm dependencies
  - Current: direct @xterm dependencies.
  - Destination: modules/thin-terminal/frontend/package.json.
  - Reason: xterm is a module implementation dependency.
- Semantic frontend implementation
  - Current: terminalClientModel.ts, terminalCellPaint.ts,
    terminalCellPresenter.ts, terminalSemanticSurface.ts, semantic input,
    selection, anchors, and semantic viewport state.
  - Destination: modules/semantic-terminal/frontend.
  - Reason: these exist only for the semantic presentation.
- Mixed frontend views
  - Current: TerminalView.tsx, terminalBrowserSession.ts,
    TerminalAttachmentController, and TerminalViewSession.
  - Destination: split into provider presentations and provider-specific
    controllers.
  - Reason: they branch on raw output, replay, and semantic screen state. A
    shared controller must not know these variants.
- Host frontend state
  - Current: useTerminalStore, terminal tab identity, terminal sessions,
    generic terminal client lifecycle, and moduleHostServices terminal sessions.
  - Destination: core/frontend/terminal-host.
  - Reason: these are host chrome and module-session adoption, not terminal
    interpretation.
- Shell composition
  - Current: AppShell directly mounts TerminalView.
  - Destination: core/frontend/terminal-host TerminalSlot.
  - Reason: the shell must resolve a selected presentation without importing an
    implementation.
- Bundle and external protocol composition
  - Current: src-tauri command registration, modules/mod.rs,
    instance/control.rs, instance/protocol.rs, and CLI terminal commands.
  - Destination: the src-tauri shell, terminal-host protocol, and
    driver-specific extensions.
  - Reason: generic lifecycle protocol cannot import semantic screen types.

Do not use a blind git move for the files marked Split. Add contract tests
first, then move one responsibility at a time. In particular, moving all of
runtime.rs into a module would wrongly give a module PTY ownership.

## Dependency direction

    core/frontend/terminal-host  ---> modules/api/frontend
    modules/*/frontend           ---> modules/api/frontend

    core/backend/terminal_host   ---> modules/api/backend
    modules/*/backend            ---> modules/api/backend

    src-tauri composition ------> core terminal host and module public entrypoints

No arrow points from core to modules/thin-terminal or
modules/semantic-terminal. No terminal module imports a sibling module.

The current capability metadata parser has exclusive-provider declarations,
but its own tests state that it performs declaration parsing only. Do not use
that metadata as a runtime terminal selector. Add an executable provider
registry in host composition.

## Shared identifiers and selection

Add one data-only terminal driver identity to modules/api in both languages.
It has a stable string value such as thin-terminal or semantic-terminal.
The identifier is not TerminalTransport and is not a boolean migration flag.

A terminal launch request may name a requested driver. The host resolves it
against the build's installed driver registry before it spawns the PTY. The
resolved driver identifier is stored with the live terminal descriptor and
returned to the frontend. A missing driver fails the launch before a child
process starts.

The normal launch path may use a centrally declared build default when the
request omits a driver. During this extraction that default remains the current
semantic behaviour. Test launches name a driver explicitly. There is no
per-view preference, hidden fallback, or late attachment that changes an
existing terminal's driver.

The provider registry must reject:

- duplicate driver identifiers;
- a frontend provider without the matching native provider when that driver
  needs native interpretation;
- a driver missing from the build profile;
- a launch request for an unavailable driver; and
- an attempt to attach a presentation whose id differs from the terminal
  descriptor.

## Frontend contract

Add terminalHost.ts to modules/api/frontend and export it from the package
root. It defines narrow contracts, not host stores or Tauri invoke access.

The host-facing part contains only facts that every terminal can use:

    TerminalHostDescriptor
    TerminalDriverId
    TerminalHostLifecycleEvent
    RawTerminalAttachment
    TerminalHostPort
    TerminalPresentationProvider

TerminalHostPort includes launch, descriptor observation, close, raw attachment
and detachment, byte write, and physical resize. RawTerminalAttachment supplies
ordered byte occurrences and lifecycle completion. Its bytes are not decoded
into cells, ANSI replay, or semantic events by the host contract.

TerminalPresentationProvider declares its driver id and one React presentation
component. The component receives the terminal id, visibility, descriptor, and
the narrow port for its selected driver. It is registered through a
ShipctlModule contribution, not discovered by imports from AppShell.

The provider-specific part must remain local to each module:

- thin-terminal turns RawTerminalAttachment bytes into xterm writes and uses
  byte write for input;
- semantic-terminal defines its own typed attachment, semantic commands,
  history, anchors, selection, effects, and screen model; and
- neither provider passes its state through a common untyped terminal object.

The core TerminalSlot reads the descriptor's driver id from the host store,
looks up the registered presentation, and renders it. It reports a clear
unavailable-driver error if the descriptor names no installed presentation.
It contains no xterm import, no canvas painter, and no semantic event decoder.

Move the current ModuleTerminalSessionsPort adapter into terminal-host. Its
public promise changes from "the host owns PTY, xterm, tab placement, and
focus" to "the host owns PTY, tab placement, focus, and physical resize".
Existing modules keep launching opaque host terminal sessions. They never need
to know which implementation was selected unless their launch policy chooses
one through the public driver id.

## Native contract

Add terminal_host.rs to modules/api/backend. It defines the traits and DTOs
needed to construct a selected native driver without importing core terminal
types:

    TerminalDriverDescriptor
    TerminalDriverFactory
    TerminalDriverSession
    TerminalDriverUpdate
    TerminalObservation
    TerminalDriverError

The host passes one ordered PTY-byte occurrence to the selected
TerminalDriverSession. The session can return provider events. A semantic
driver can return a host-serialised parser reply because it is the selected
terminal interpreter. The host appends that reply to the one PTY writer in
actor order.

The thin observer uses a separate observer interface. Its result type contains
only TerminalObservation values. It has no reply bytes, resize operation,
screen state, replay request, or mutation hook. This enforces the intended
Rust-side open-source parser use: observe selected signals, then leave byte
interpretation and rendering to the browser terminal component.

Core owns the actor loop. It invokes the driver only inside that loop and does
not expose the PTY handle, writer, or reader to a module. A driver cannot make
its own read loop, reorder output, or write directly to the child.

## Stream and input rules

The host exposes three different things. They must not be merged.

- Host lifecycle: core terminal host owns descriptors, started and exited
  events, metadata, selected driver, and attachment closure.
- Raw terminal stream: core terminal host owns exact ordered child PTY bytes
  for thin-terminal, plus a private ordered feed to the selected native driver.
- Provider stream: the selected module owns semantic screens and effects for
  semantic-terminal, or local xterm parser events for thin-terminal.

The raw frontend stream may require an IPC encoding such as a numeric byte
array. That encoding is not preprocessing. The preservation test compares
concatenated original PTY bytes with concatenated delivered bytes.

Input follows the same split:

- thin-terminal supplies bytes from its browser terminal component. This
  includes browser-side protocol replies. The host writes those bytes in actor
  order.
- semantic-terminal supplies semantic input. Its native driver encodes it
  against its current terminal modes, and the host writes the resulting bytes
  in actor order.
- core validates terminal lifecycle and serialises the write. It never
  interprets input as terminal meaning.

## Resize contract

There are two distinct resize operations.

1. A frontend presentation measures its own container and proposes columns and
   rows.
2. The host validates the request and applies it to the PTY with
   MasterPty::resize.

The second operation stays in core because it changes what the child process
sees. The present core runtime does this in its resize method before it calls
the Ghostty resize. After extraction:

- thin-terminal stops after the host PTY resize and lets xterm resize its local
  display;
- semantic-terminal receives an ordered resize notification after the PTY
  resize succeeds and adjusts its semantic state; and
- the selected presentation is the only source allowed to request the live
  terminal's resize.

The core host does not compute cell width, wrapping, reflow, viewport history,
or a screen image.

## Target package responsibilities

### core/backend/src/terminal_host

Own PTY spawning, process termination, raw reader and writer, terminal record,
descriptor registry, physical geometry, lifecycle events, generic terminal
commands, generic raw attachment, and the driver registry invocation boundary.

Its dependencies must not include libghostty-vt or terminal semantic DTOs.

### core/frontend/terminal-host

Own terminal tab state, generic terminal actions, module-session adoption,
terminal descriptor reduction, the terminal provider registry, and TerminalSlot.

Its dependencies must not include @xterm packages, semantic canvas code, or
semantic event schemas.

### modules/thin-terminal

The frontend owns xterm construction, browser fitting, renderer add-ons,
browser-side input, local scrollback, local selection, and local terminal
protocol replies. The optional backend owns only a passive parser-based
observer that emits selected TerminalObservation values.

### modules/semantic-terminal

The backend owns Ghostty, semantic projection, semantic input encoding,
semantic effects, semantic history, anchors, selection, screen publication,
and driver-specific recovery. The frontend owns semantic decode, model,
painting, pointer and IME adaptation, semantic view lifecycle, and its
capability scenarios.

### modules/api

Own stable, small, versioned contracts. It must not own an implementation,
store, renderer, host actor, or feature-default policy.
