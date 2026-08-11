# Execution steps

Each step makes one boundary true and proves it before the next step uses it.
The work is ordered to preserve the current semantic path while thin-terminal
is introduced. It is not a request to carry both renderers in one terminal.

## 1. Record the architectural replacement and make the baseline explicit

1. Add a short decision note to the single-VT end-state material. State that
   this plan changes the global one-parser target to one selected authority per
   terminal session.
2. Preserve the current terminal fixtures, scenario register, performance
   notes, and compact-wire measurements as semantic-terminal evidence. Do not
   rewrite them as thin-terminal evidence.
3. Add an extraction inventory test that lists every direct import of:

       core/frontend/terminal
       core/backend/src/terminal
       @xterm
       libghostty-vt
       TerminalTransport
       TerminalView

   The test starts as an inventory. Later steps replace it with negative
   boundary checks.
4. Run the existing fast test and workspace Rust test lanes before source
   movement. Record only pass or fail and the command output needed to explain
   a failure. Existing unrelated work must stay outside the extraction changes.

Proof: the source map is known, the existing semantic evidence is preserved,
and a future core dependency on a terminal implementation has a detector.

## 2. Create the host-to-module contracts before moving implementations

1. Add modules/api/frontend/src/terminalHost.ts and its export.
2. Add modules/api/backend/src/terminal_host.rs and its export.
3. Define the common driver id, host descriptor, raw attachment, host port,
   frontend presentation provider, native factory, native session, and passive
   observer contracts described in 01-boundaries-and-contracts.md.
4. Extend ShipctlModule with an executable terminal presentation contribution.
   Keep it separate from capability-manifest metadata. The contribution exists
   only for build-installed modules.
5. Add contract tests for duplicate ids, missing providers, mismatched
   frontend/native ids, unavailable launch selections, and an attempted
   attachment with the wrong provider id.
6. Extend ModuleTerminalSessionsPort only with host-level selection data if a
   module needs to request a driver. Do not expose xterm, Ghostty, screen,
   history, or selection types through this port.

Proof: core and a terminal module can compile against the same narrow contract
without either importing the other's implementation.

## 3. Establish a neutral terminal host in core

1. Create core/backend/src/terminal_host and core/frontend/terminal-host.
2. Move or split the host-only definitions first:

   - TerminalId, attachment identity, descriptor, metadata, lifecycle, exit,
     terminal owner, and agent activity;
   - TerminalRecord and its registry reduction;
   - process creation, termination, PTY reader, PTY writer, and physical
     TerminalGeometry;
   - generic spawn, list, get, metadata, close, write, raw attach, raw detach,
     and resize operations;
   - terminal tab state, terminal actions, terminal client descriptor runtime,
     generic terminal sessions, and module-session adoption.

3. Refactor the runtime actor so its only unconditional output action is:

       read PTY bytes
       assign the next ordered occurrence
       publish the byte occurrence to raw attachments
       deliver the same occurrence to the selected native driver

   It must not call Ghostty directly. The selected driver is responsible for
   interpretation.
4. Keep the actor's ordered writer in core. It accepts child writes from the
   selected presentation or selected driver only after host lifecycle checks.
5. Change the host resize sequence to apply MasterPty::resize first and notify
   the selected driver only after success. Delete the unconditional
   self.vt.resize call from the host actor.
6. Add TerminalDriverId to the host launch request and descriptor. Select the
   factory before spawn. Store the resolved id for the life of the terminal.
7. Give core/frontend/terminal-host a provider registry and TerminalSlot.
   Change AppShell to mount TerminalSlot, not TerminalView.
8. Move moduleHostServices terminal session wiring to terminal-host. Keep its
   public service generic.

This step may retain a short-lived internal adapter while semantic-terminal is
being moved, but the adapter must be named migration-only, have one caller,
and be removed in step 5. It must not become a third terminal implementation.

Proof:

- a host actor test proves byte occurrence order, one writer, physical resize,
  terminal exit, and descriptor updates without loading Ghostty;
- a frontend test proves TerminalSlot selects a registered presentation using
  the descriptor driver id; and
- core frontend and core backend compile with no direct implementation import
  after the temporary adapter is removed.

## 4. Extract semantic-terminal as one vertical module

1. Create modules/semantic-terminal/backend as a feature-gated Tauri plugin
   crate and modules/semantic-terminal/frontend as a workspace package.
2. Move libghostty-vt from core/backend/Cargo.toml to the semantic module
   Cargo manifest.
3. Move the native semantic implementation from the old terminal capability:

   - VtReplayEngine and Ghostty compatibility coverage;
   - projection, wire encoding, screen cache, screen credit, and semantic
     publication;
   - semantic effects and semantic input encoding;
   - history, anchors, selection, and semantic resize;
   - semantic event contracts, native fixtures, traces, and measurements.

4. Implement TerminalDriverFactory and TerminalDriverSession in the semantic
   module. The driver consumes the host's ordered PTY bytes and returns only
   semantic module events and actor-ordered reply bytes.
5. Move the semantic frontend:

   - terminal event decoder and semantic attachment bootstrap;
   - terminal client model and client cache;
   - cell painter, canvas target, presenter, surface, font measurement, and
     theme adaptation;
   - semantic input, pointer routing, IME, selection, anchors, history, and
     viewport composition;
   - semantic performance metrics, scenarios, fixtures, and capability
     register.

6. Split TerminalViewSession and TerminalAttachmentController rather than
   preserving their optional legacy-and-semantic ports. The semantic module
   owns the controller that understands semantic screens, semantic effects,
   snapshots, credit, recovery, history, and anchors.
7. Register the semantic frontend provider through the normal static module
   list and register its native factory from src-tauri module composition.
8. Keep semantic-terminal as the current build default until a later product
   decision changes it.

Proof:

- all existing semantic fixtures pass through the semantic module factory;
- semantic resize changes the PTY and semantic model in the required order;
- semantic input is encoded by the semantic module, not core;
- core has no libghostty-vt dependency; and
- AppShell renders the same semantic terminal through TerminalSlot.

## 5. Extract thin-terminal as a separate vertical module

1. Create modules/thin-terminal/frontend and add it to the pnpm workspace.
   Move the direct @xterm dependencies from the application root to its
   package manifest.
2. Move the xterm-specific frontend code:

   - terminalXtermSurface, output queue, xterm measurement, renderer add-ons,
     renderer preference, and xterm viewport helpers;
   - xterm theme and OSC handlers that belong to xterm parsing;
   - xterm-local fit, selection, scrollback, links, and browser input
     behaviour; and
   - xterm tests and thin-terminal scenarios.

3. Implement the thin frontend presentation provider. It attaches to the host
   raw stream, feeds exact byte chunks to xterm in order, sends xterm input as
   byte writes, and requests the physical resize through the host port.
4. Create modules/thin-terminal/backend only if the selected Rust-side
   observation needs a native parser. Put that parser and its mapping to
   TerminalObservation values in this module.
5. Make the observation boundary passive by type. A thin observer receives
   output and returns observations only. It has no host writer, resize
   callback, semantic event type, screen cache, or render data.
6. Register thin-terminal in the same build-installed provider registry. It
   is selected only by an explicit TerminalDriverId in test launches until
   product policy says otherwise.
7. Add a byte-identity trace test. Feed control sequences split at arbitrary
   chunk boundaries through the host and assert that the concatenated
   thin-terminal delivered bytes are exactly the input trace.

Proof:

- thin-terminal can start a PTY, display the raw stream, accept input, and
  resize the child without Ghostty in the host path;
- a passive observer can report an allowed sideband event but cannot write a
  parser reply; and
- core frontend has no @xterm import.

## 6. Split external commands and existing consumers

1. Replace direct core terminal command registration in src-tauri/src/lib.rs
   with generic terminal-host commands and module plugin command registration.
2. Keep generic commands limited to lifecycle, descriptors, launch, close,
   raw attach, raw write, and physical resize.
3. Move semantic snapshot, screen credit, semantic input, history, anchors,
   and selection commands behind semantic-terminal's driver contract or
   namespaced plugin commands.
4. Replace TerminalTransport in Tauri and control protocol DTOs with the
   selected TerminalDriverId and the explicit stream used by the request.
5. Split instance/control.rs, instance/protocol.rs, and CLI terminal code:

   - generic terminal control imports terminal-host DTOs only;
   - thin raw attachment uses the host raw stream;
   - semantic control imports semantic-terminal public protocol types only
     where it offers semantic operations.

6. Update assistant, commands, project, host surface, and lifecycle call sites
   to use terminal-host public exports. Existing modules retain their opaque
   TerminalAuthority and ModuleTerminalSessionsPort access; they do not import
   a terminal implementation.
7. Move generic frontend platform Tauri DTOs into terminal-host or modules/api.
   A core platform type must not name a semantic screen or xterm surface.

Proof:

- the CLI and control protocol compile without importing Ghostty projection,
  xterm, or the deleted TerminalTransport enum;
- a module can launch a terminal through its existing host port without
  acquiring renderer access; and
- all Tauri terminal commands have one clear host or module owner.

## 7. Remove mixed-core compatibility paths

1. Delete the temporary WEBVIEW_TERMINAL_TRANSPORT constant and all
   legacy-versus-semantic branches in terminalBrowserSession.ts and
   terminalViewSession.ts.
2. Delete the old TerminalTransport enum, legacy replay event, and branches
   that select event encoding inside core.
3. Delete the old core TerminalView, browser session, semantic event decoder,
   xterm output queue, and semantic model paths after their owning module tests
   pass.
4. Delete the old core/backend/src/terminal module after its host code has
   moved to terminal_host and its semantic code has moved to
   modules/semantic-terminal.
5. Change the inventory test from positive discovery to negative boundary
   checks. It must fail if core imports @xterm, libghostty-vt, semantic
   projection, semantic wire, xterm renderer code, or a terminal module
   implementation path.

Proof: the only terminal-specific code remaining in core is the PTY host and
generic terminal chrome described in this plan.

## 8. Compare implementations and make the later product decision

1. Build a test profile that carries both module implementations.
2. Start separate new sessions with explicit thin-terminal and
   semantic-terminal driver ids. Never attach both renderers as active
   authorities to one PTY.
3. Run the common host lifecycle scenarios for each implementation. Run each
   implementation's own rendering, input, recovery, accessibility, and
   performance scenarios separately.
4. File the observed differences as capability facts. Do not translate a
   thin-terminal limitation into a hidden semantic state server, and do not
   translate a semantic limitation into a second browser parser.
5. After an explicit owner choice, update build defaults and remove the
   rejected module only if the conditions in 03-verification-and-cutover.md
   are met.

Proof: the architecture allows a real comparison while every live terminal has
one unambiguous authority.
