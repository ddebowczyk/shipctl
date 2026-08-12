# Verification and cutover

## What must be true after extraction

The result is a structural change, so compilation alone is not sufficient.
The proof has four parts: boundaries, host behaviour, each implementation, and
side-by-side operation.

- Dependency boundary: core has no xterm, Ghostty, semantic renderer, or
  terminal module implementation import. Each module imports only modules/api
  and its own code.
- Host behaviour: a terminal host actor creates one PTY, orders reads and
  writes, publishes exact raw occurrences, tracks lifecycle, and applies one
  physical resize.
- Thin-terminal: raw chunks reach xterm in exact order; browser input reaches
  the host writer; passive Rust observations cannot mutate PTY or terminal
  state.
- Semantic-terminal: existing semantic fixtures, input-mode tests, recovery
  tests, and presentation capability evidence pass through the module boundary.
- Coexistence: two different terminal sessions can select different drivers in
  one test build without a shared parser, writer, presentation, or resize
  authority.

No performance number in the existing semantic research becomes a new
acceptance threshold. Retain the measurements and compare equivalent workloads,
but report the results rather than inventing a byte, frame, or time budget.

## Automated checks

Add focused tests at the boundaries below. Keep existing tests with their
implementation when moving source files.

### Module API tests

- A driver registry accepts matching frontend and native providers.
- It rejects duplicate ids, missing ids, and a descriptor that requests a
  missing provider.
- A provider cannot attach to a terminal selected for another driver.
- Terminal host DTOs contain no semantic screen, cell, replay, xterm, or
  Ghostty type.
- The passive observer result type has no field through which it can request a
  PTY write, resize, replay, or frame.

### Host actor tests

- A byte trace with control sequences split on different read boundaries
  reaches the raw attachment as the identical ordered byte sequence.
- The selected native driver sees each occurrence in the same order as the
  host raw attachment.
- The actor serialises browser byte input and semantic-driver reply bytes
  through one writer.
- A failed physical resize does not notify the selected driver of a successful
  resize.
- A successful physical resize reaches the selected semantic driver after the
  PTY resize.
- Closing a terminal detaches streams and stops its driver without affecting a
  different terminal.

### Thin-terminal tests

- The xterm provider attaches and detaches without a semantic event decoder.
- xterm output is applied in occurrence order, including data split through an
  escape sequence.
- xterm input and browser-generated protocol replies use the host byte-write
  port.
- A hidden and later visible thin presentation has its documented local
  behaviour. The test must not claim semantic history continuity.
- Each selected Rust observer event is mapped to a stable
  TerminalObservation, and an observer has no capability to change terminal
  bytes.

### Semantic-terminal tests

Move the current semantic fixtures and tests with their code. They remain
implementation tests:

- Ghostty compatibility, semantic projection, wire fixtures, history, anchors,
  selection, screen credit, effects, and recovery;
- semantic input, mouse, focus, paste, and resize ordering;
- semantic client model, screen decode, cell painting, IME, links, pointer
  routing, and canvas presentation; and
- the semantic capability register and measured scenario harness.

The moved tests must pass without importing core terminal implementation code.

### Boundary checks

Extend the existing modularity tests to fail when:

- core/backend/Cargo.toml names libghostty-vt;
- core/frontend or the root application package directly names @xterm;
- AppShell imports a terminal module implementation or a concrete TerminalView;
- a terminal module imports another terminal module or a core terminal-host
  implementation file;
- modules/api imports renderer, Ghostty, Tauri command, Zustand store, or host
  actor code;
- TerminalTransport or WEBVIEW_TERMINAL_TRANSPORT remains; or
- a general message-bus API carries PTY output.

Use source-aware checks where possible. A text check is acceptable only for
dependency manifests or an explicitly named deleted symbol.

## Test commands

Run the repository checks that exist at the time of the change:

    just test fast
    just check all
    cargo test --workspace

Run the moved terminal tests by their new module paths while developing the
extraction. If a new package-specific command is added, make it a normal
repository command and use it in the release check. Do not rely on a one-off
local shell command as the only proof of an implementation boundary.

Run the semantic release measurement only as a report:

    cargo test -p tauri-plugin-shipctl-semantic-terminal --lib --release measure -- --ignored --nocapture

After the source moves, update that command and its documentation to the
semantic-terminal crate path. The measurement still reports facts; it does not
block cutover on an invented threshold.

## Manual packaged-app checks

The browser terminal and the semantic canvas have different browser and
accessibility risks. Exercise both in a packaged development build.

- Basic output, colours, Unicode, and links
  - Thin-terminal evidence: browser terminal result.
  - Semantic-terminal evidence: existing semantic capability-register result.
- Keyboard, paste, IME, and mouse modes
  - Thin-terminal evidence: browser terminal owns protocol result.
  - Semantic-terminal evidence: semantic input and presentation result.
- Resize
  - Thin-terminal evidence: the child sees host physical size and xterm
    repaints locally.
  - Semantic-terminal evidence: the child and semantic model observe ordered
    resize.
- Bell, title, and activity
  - Thin-terminal evidence: xterm or the passive observer emits the selected
    sideband fact.
  - Semantic-terminal evidence: the semantic driver emits its ordered effect.
- Hidden output and return
  - Thin-terminal evidence: local browser terminal behaviour is recorded.
  - Semantic-terminal evidence: semantic credit and recovery behaviour is
    recorded.
- Selection and history
  - Thin-terminal evidence: local to the thin presentation; no shared
    guarantee is claimed.
  - Semantic-terminal evidence: the semantic module owns history and anchors.
- Slow or recreated surface
  - Thin-terminal evidence: local presentation result is recorded.
  - Semantic-terminal evidence: semantic recovery scenarios apply.

Do not label a feature as parity merely because the other implementation has
it. Each row must state whether it is supported, absent by design, or needs a
separate product decision.

## Side-by-side comparison rules

The comparison uses separate PTYs. For example, start the same fixture command
once with thin-terminal and once with semantic-terminal. This lets each driver
be tested without making one process answer to two terminal authorities.

For every comparison session, collect:

- selected driver id;
- host lifecycle result;
- raw byte preservation result for thin-terminal;
- semantic fixture or scenario result for semantic-terminal;
- observed user-visible capability facts; and
- any performance measurements with workload and environment.

Do not infer that one implementation can supply the other implementation's
state. In particular:

- thin-terminal does not acquire host selection, history, or late-attach state
  just to equal semantic-terminal;
- semantic-terminal does not keep an xterm parser as a fallback; and
- a passive observer does not become a parser reply engine.

## Cutover conditions

This plan creates modules before it removes one. The final removal is a
separate owner decision, not an automatic result of code extraction.

An owner may choose a default or remove an implementation only after:

1. Both modules have passed their stated proof in a build that includes them.
2. The common host lifecycle proof passes for both driver ids.
3. The intended product capability contract says which of the differing
   history, selection, late-attach, and control behaviours is required.
4. Packaged-app evidence covers the selected implementation's required
   rendering, input, resize, effect, and recovery behaviour.
5. The default selection and unavailable-driver behaviour are documented.
6. The build profile and user migration behaviour are approved explicitly.

If thin-terminal is chosen, remove semantic-terminal only after its semantic
public commands and documentation are retired or intentionally preserved as a
separate non-terminal feature. If semantic-terminal is chosen, retain no hidden
xterm fallback or raw replay path in core. If both stay, retain both as explicit
build-installed modules and keep the one-authority-per-session rule.

## Final deletion checklist

When the relevant product decision is approved, remove the obsolete pieces in
one coherent change:

- the old core terminal directory and all compatibility re-exports;
- TerminalTransport and the old legacy-versus-semantic event switch;
- WEBVIEW_TERMINAL_TRANSPORT and mixed optional ports in the old view session;
- direct core dependencies on @xterm and libghostty-vt;
- direct AppShell import of TerminalView;
- duplicate terminal command registrations; and
- end-state documentation that still claims a different global architecture.

Keep the host PTY path and its byte-preservation tests if thin-terminal remains
available. Removing the semantic byte fallback is safe only after the chosen
module's own recovery and product contract are proven. Do not delete a byte
path merely because a semantic module exists.
