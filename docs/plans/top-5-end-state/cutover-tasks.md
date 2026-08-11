# Single-VT cutover tasks

## Outcome

Delete the migration state after the semantic terminal passes
[finalization-tasks.md](finalization-tasks.md). Every Shipctl terminal client
then consumes host-owned semantic state. xterm, raw child-output publication,
ANSI replay, byte-renderer adapters, and the legacy transport switch no longer
ship.

Cutover is deletion work. It must not introduce a third path, another fallback,
or more comparison instrumentation.

## Entry gate

Do not begin destructive deletion until all of these facts are true:

- `finalization-tasks.md` F6 passes.
- `blockingCapabilities()` returns an empty list.
- The exact commit and packaged build that passed finalization are recorded.
- The working tree is understood and unrelated changes are protected.

Rollback after deletion is a source or release rollback to the recorded
baseline. There is no permanent runtime legacy switch.

## Contracts that remain

- PTY output bytes enter only the backend terminal actor.
- The host VT remains the only terminal semantic authority.
- Semantic screen, history, effects, selection, and typed input remain public
  terminal boundaries.
- `shipctl terminals write` keeps its public exact-byte contract for literal
  UTF-8, base64, and stdin input. It writes bytes to the child; it does not make
  child-output bytes a client rendering protocol.
- CLI ANSI is local presentation generated from semantic cells.
- OSC 8 links remain. Plain-text URL auto-detection does not return.

## Non-goals

- No wire optimization, protocol redesign, or profiling.
- No behavior changes to the proved semantic path.
- No new compatibility flags or per-client transport settings.
- No removal of explicit child-input byte APIs that remain public contracts.
- No unrelated terminal features.

## Execution order

C1 blocks C2 and C3. C2 and C3 block C4. C4 blocks C5. C5 blocks C6.
Deletion can span commits, but the completion gate stays closed until C6 passes.

## C1 — Make semantic transport the only selected transport

### C1 purpose

Remove all live callers of the legacy attachment path before deleting its
implementation.

### C1 work

- Keep the webview on its existing semantic selection.
- Change control-socket attachment defaults and explicit attachment requests to
  semantic state.
- Change CLI attachment and interactive presentation to semantic state.
- Remove user-facing encoding choices that can request legacy output.
- Characterize `shipctl terminals write` before edits and preserve its exact
  input-byte behavior.
- Add a temporary negative test that fails when any production caller requests
  `TerminalTransport::Legacy`. This test is deleted or simplified after the
  enum itself is removed.

### C1 acceptance criteria

- Webview, control socket, CLI presentation, and module-facing terminal adapters
  all request semantic attachment.
- No production caller can select legacy attachment.
- `shipctl terminals write` still accepts its documented literal, base64, and
  stdin inputs byte-for-byte.
- Legacy implementation code may remain temporarily, but it is unreachable
  from production callers.

### C1 verification

- Run focused webview, control, and CLI attachment tests.
- Run exact-byte `terminals write` tests.
- Search production call sites for legacy attachment requests.

## C2 — Delete the frontend xterm and byte-rendering path

### C2 purpose

Remove the second browser VT and every adapter that exists only to feed it.

### C2 work

- Delete `terminalXtermSurface.ts`, `terminalXtermMeasure.ts`, and the legacy
  `browser.ts` entrypoint.
- Delete `terminalOutputQueue.ts` and byte-output/replay installation from
  `terminalViewSession.ts` and `terminalAttachmentController.ts`.
- Remove the legacy branch from `terminalBrowserSession.ts` and delete the
  `TerminalTransport` argument from its composition boundary.
- Delete xterm-only renderer policy, addon factories, viewport repair, cache
  branches, CSS, fixtures, and tests after confirming they have no semantic
  caller.
- Keep pure semantic modules such as cell planning, Canvas2D painting, font
  metrics, terminal theme policy, viewport composition, and renderer
  recreation.
- Remove xterm exports from `core/frontend/terminal/index.ts`.

### C2 acceptance criteria

- No frontend source imports or constructs xterm.
- No frontend code accepts raw child output or ANSI replay.
- The semantic model and Canvas2D surface still pass their focused tests.
- Hiding, showing, resizing, selection, history, IME, and renderer recovery keep
  their finalization behavior.

### C2 verification

- Run the frontend terminal test lane.
- Use `rg` to prove that xterm imports, byte-output queues, replay installation,
  and the legacy browser entrypoint are absent from production frontend code.

## C3 — Delete legacy control and CLI output presentation

### C3 purpose

Remove raw output and replay as client attachment formats while preserving
explicit child-input bytes.

### C3 work

- Delete raw output and replay frame variants from
  `core/backend/src/instance/protocol.rs`.
- Delete their mapping, base64 child-output handling, and encoding branches from
  `core/backend/src/instance/control.rs`.
- Delete CLI raw child-output and replay painters from `cli/src/terminals.rs`.
- Keep semantic NDJSON, the semantic local painter, interactive input, resize,
  cursor, alternate-screen, signal, job-control, effects, and exit behavior.
- Keep the explicit `terminals write` byte-input command and its tests.

### C3 acceptance criteria

- Control and CLI attachments accept only semantic terminal events.
- CLI-generated ANSI is derived only from semantic cells.
- No raw child-output or replay frame crosses the control socket.
- Exact-byte terminal input remains supported and tested.

### C3 verification

- Run focused control protocol and CLI tests.
- Search control and CLI production code for legacy frame variants and raw
  child-output painting.

## C4 — Delete the backend legacy publication and replay authority

### C4 purpose

Remove the remaining code that can publish a second terminal representation.

### C4 work

- Delete `TerminalTransport::Legacy` and then delete `TerminalTransport` if no
  meaningful choice remains.
- Delete `TerminalEvent::Output`, `TerminalEvent::Replay`, `TerminalReplay`, and
  their contract samples.
- Delete raw output publication, replay snapshots, legacy subscriber audiences,
  and legacy overflow or recovery branches from the runtime and publication
  modules.
- Delete `VtReplayEngine`, `format_active_screen`, formatter-based screen
  reconstruction, and legacy-only tests. Retain host VT duties that still live
  near that code; move them only when deletion makes the boundary false.
- Remove legacy attach defaults and migration-switch plumbing from service,
  commands, Tauri registration, measurement, and trace code.
- Keep PTY ingress, host parsing, parser replies, host input encoding, semantic
  publication, history, anchors, selection, effects, and lifecycle.

### C4 acceptance criteria

- The backend has one terminal event representation for client presentation.
- No ANSI replay or raw child-output event can be constructed or published.
- PTY input and output still cross their explicit host boundaries correctly.
- Semantic fanout, slow-client isolation, occurrence ordering, and recovery
  tests pass.

### C4 verification

- Run focused backend terminal and control tests.
- Use structural and text searches to prove the deleted enum variants, replay
  formatter, and legacy publication branches are absent.

## C5 — Remove dependencies and install permanent negative gates

### C5 purpose

Turn the single-VT claim into a durable absence check.

### C5 work

- Remove `@xterm/xterm` and the Fit, Unicode 11, Web Links, and WebGL addons from
  `package.json` and `pnpm-lock.yaml`.
- Regenerate terminal contracts and fixtures after legacy shapes are deleted.
- Replace temporary switch checks with permanent gates that reject:
  - xterm imports or dependencies;
  - raw child-output and ANSI replay event shapes;
  - browser-generated VT input bytes;
  - client-side terminal parsing or width authority; and
  - reintroduction of a legacy transport selector.
- Remove comparison-only scenarios, metrics, fixtures, and documentation that
  have no semantic production purpose.
- Update capability exports and modularity rules for the smaller terminal
  surface.

### C5 acceptance criteria

- Dependency installation contains no xterm package or addon.
- Generated contracts reproduce exactly and contain no legacy event shape.
- Negative gates fail against a deliberate legacy fixture and pass against the
  production tree.
- No migration or comparison code remains merely for possible future rollback.

### C5 verification

- Run dependency, generated-contract, modularity, and negative checks.
- Inspect `pnpm-lock.yaml` and production imports for xterm residue.

## C6 — Validate, document, and close the migration

### C6 purpose

Prove the product ships one host-owned VT path and leave truthful operating
documentation.

### C6 work

- Update terminal architecture and operations documentation to describe only
  the semantic production path.
- Replace or archive dated migration status documents that would direct a new
  agent toward the deleted legacy path.
- Run the complete repository and release gates.
- Build the packaged app and repeat the finalization interaction procedure.
- Run control and CLI semantic attachment against the packaged backend.
- Record the release/build identity and the source rollback procedure.

### C6 acceptance criteria

- `just test full`, `just check all`, `just check release-bundle`, and
  `just modularity boundaries` pass.
- The packaged webview, control socket, and CLI all consume semantic state.
- Repository searches and negative gates find no second VT, legacy transport,
  raw child-output presentation, or ANSI replay path.
- Documentation contains no active instruction to enable or restore the legacy
  path.
- Rollback means reverting source or release artifacts, not toggling a runtime
  fallback.

## Stop condition

Stop when C6 passes. The terminal migration is then complete. Any new terminal
feature, optimization, or measurement belongs to ordinary product work and is
not part of this cutover.
