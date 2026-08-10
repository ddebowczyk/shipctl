# Host semantic authority is production

## Outcome

The backend owns terminal meaning as typed, owned data. `RuntimeActor` feeds
child output into Ghostty once, projects the resulting state and ordered effects
into Shipctl domain values, and accepts semantic input operations that it
encodes using Ghostty's current modes.

The semantic production path does not format Ghostty state back into ANSI and
does not depend on xterm to interpret output, modes, cell width, selection, or
input. Legacy output and replay may remain beside it only until the coordinated
cutover in
[area 05](05-cutover-deletes-the-second-vt.md).

This gate produces an in-process semantic domain for
[area 02](02-semantic-protocol-reaches-every-client.md). It does not define the
wire format, subscriber baselines, browser model, or presentation surface.

## Context and purpose

The live runtime is still dual-VT:

- `RuntimeActor::handle_output` feeds `VtReplayEngine` and then publishes the
  original PTY bytes as `TerminalEvent::Output`;
- `RuntimeActor::resize` and `RuntimeActor::set_theme` create ANSI replay;
- `VtReplayEngine::replay` uses `format_active_screen` to reconstruct escape
  sequences from Ghostty state; and
- the frontend gives those sequences to xterm, which derives the usable model
  again.

Verify the second point rather than take it:

```sh
rg -n 'self\.replay\(\)' core/backend/src/terminal/runtime.rs
```

Three hits, in `resize`, `snapshot` and `set_theme`. `snapshot` is the third
and only legitimate caller, because recovery is what a reconstruction is for.
The other two are routine presentation changes, so two of the three producers of
a full terminal reconstruction are events that should not reconstruct anything.
That ratio is the reason this area is first, and the command re-proves it after
any rename.

Two things this area does **not** claim, because both were tested and refuted.
A replay does not drop history: it re-encodes every retained row, so resize and
theme change cost the re-encoding of the whole retained buffer rather than the
loss of its contents. And today's engine does not overwrite child-authored
colors: libghostty-vt holds OSC 4/10/11 state in a layer above the host
defaults, so `apply_theme` writing the default layer is correct. Both are
pinned by tests in `core/backend/src/terminal/replay.rs`. The requirement below
to preserve child-authored color state is a constraint on the new path, not a
defect report about the old one.

The implemented feasibility enabler is deliberately test-only.
`core/backend/src/terminal/compat.rs` proves that the pinned safe API can expose
active and retained cells, graphemes, width and continuation, style, colors,
wrap, cursor, modes, palette, links, prompt marks, selection, effects, and input
encoders as owned values. Production still uses `replay.rs` as its read model.

The first closure area moves that proved seam into the live actor without
reopening completed preparation:

- byte-based retention in `retention.rs` and `TerminalService` stays the only
  product retention authority;
- the pinned Ghostty revision stays reproducible;
- the existing actor and service remain the single backend lifecycle writers;
  and
- the compatibility corpus remains a dependency-upgrade gate.

## Dependencies and gate

The implemented compatibility, retention, dependency, contract, controller,
and lifecycle enablers are prerequisites and regression gates.

This area can start immediately. It blocks semantic protocol freeze in area 02.
Representative domain fixtures may be shared with area 02 and presentation
feasibility work before this area passes.

Gate 01 passes when production can expose every required terminal fact and
operation without ANSI reconstruction or browser terminal authority, and OSC 9
has one approved disposition.

The OSC 9 disposition is tracked in
[`docs/ops/terminal-osc9-upstream-task.md`](../../ops/terminal-osc9-upstream-task.md),
which has a named human owner. Read it before choosing a disposition, and note
that it currently states two different start conditions — start now because the
upstream merge is not ours to schedule, and the clock starts at closure area 5.
Resolving that contradiction belongs to the page's owner, not to this plan, but
an area that depends on the page cannot leave the reference unmade.

## Affected live modules

- `core/backend/src/terminal/runtime.rs`
  - `RuntimeActor`, `RuntimeActor::handle_output`, `resize`, `set_theme`,
    snapshot handling, effect ordering, and `RuntimeCommand::Write`.
- `core/backend/src/terminal/replay.rs`
  - `VtReplayEngine` and `format_active_screen` lose authority on the semantic
    path. Area 05 deletes the legacy formatter after cutover.
- `core/backend/src/terminal/types.rs`
  - add owned semantic domain values and semantic commands beside the legacy
    `TerminalEvent::Output`, `TerminalEvent::Replay`, and `TerminalReplay`.
- `core/backend/src/terminal/compat.rs`
  - promote proved extraction patterns into production modules while keeping
    the corpus independent and exhaustive.
- `core/backend/src/terminal/retention.rs` and `service.rs`
  - preserve the committed construction-time byte policy and actor ownership.
- `core/backend/src/terminal/commands.rs`
  - expose semantic operations to later protocol adapters without creating a
    second runtime writer.

Production projection code should live under the backend terminal capability,
not in `src-tauri`, instance control, or frontend modules.

## Work to be done

### 1. Define the owned terminal domain

Create Shipctl-owned values for:

- active and alternate screen identity and geometry;
- retained history and addressable history anchors;
- grapheme content and exact host-decided cell occupancy, including wide leads
  and continuation or spacer cells;
- style, resolved foreground and background, palette and defaults;
- wrap and continuation, cursor shape and visibility, and terminal modes;
- per-cell links and semantic prompt metadata;
- selection anchors, kinds, extension state, and selected content;
- dirty regions and full-invalidation reasons; and
- ordered occurrence effects such as title, working directory, bell,
  notification, clipboard, terminal reply, and exit.

Every value crossing the projection boundary must own its data. It cannot hold
a Ghostty grid reference, borrowed selection, borrowed title, or borrowed
working-directory value after the read operation returns.

### 2. Make projection a runtime responsibility

Replace the semantic path's formatter read with an owned projector maintained by
`RuntimeActor`. One actor operation must preserve the order among parser state
mutations, dirty regions, occurrence effects, replies, and lifecycle changes.

The actor assigns a monotonic semantic state revision to mutations. Area 02
defines subscriber base revisions and their lossless wire representation; this
area defines when the underlying state changes.

Use dirty information where the pinned API exposes it. When exact damage cannot
be proved, publish an explicit full invalidation rather than inferring a partial
update that can leave stale cells.

### 3. Make ordinary host changes semantic transitions

- Resize the PTY and Ghostty in actor order, then expose the host-reflowed state
  and geometry as a semantic transition. Do not create replay ANSI on the
  semantic path.
- Apply theme defaults without overwriting child-authored OSC palette or default
  color state. Publish the resolved palette and defaults, not merely the
  requested application theme.
- Keep focus and visibility out of recovery. Focus is a semantic input or mode
  transition; visibility is a client presentation concern.

### 4. Move terminal-aware input to the host

Define semantic commands for:

- key and composed-text input;
- bracketed and ordinary paste;
- mouse press, release, motion, wheel, and modifier state;
- focus changes;
- selection start, extension, autoscroll, word, line, range, and output
  selection; and
- named application actions and presets.

`RuntimeActor` uses current Ghostty modes to encode required PTY bytes and keeps
those writes ordered with parser replies and lifecycle. The webview does not
retain an arbitrary raw-write command on the semantic path.

Selection semantics must cover wrapped rows and retained history as well as the
existing compatibility fixtures. Browser pointer handling belongs to area 04;
the meaning and state transition belong here.

### 5. Close the OSC 9 effect gap

Before area 02 freezes the semantic effect union, choose and prove exactly one
of these outcomes:

1. the owned Ghostty dependency or binding exposes the ordered OSC 9 payload;
2. a bounded backend effect extractor reads ordered ingress, cannot mutate
   terminal state, and cannot grow into a screen or mode parser; or
3. a named product owner removes OSC 9 notifications from the product contract.

Keeping the xterm OSC 9 handler or forwarding child PTY bytes is not an
acceptable outcome. If a bounded extractor is selected, its public API and
negative tests must enforce its single-purpose scope.

### 6. Keep history policy singular

Expose retained history as semantic cells and host anchors without changing the
implemented byte-based retention setting or its construction-only behavior.
Area 02 defines protocol window requests and in-flight invalidation. This area
provides authoritative history reads and eviction facts from the one retained
Ghostty state.

## Boundary exclusions

This area does not:

- choose transport encoding, frame sizes, batching, or flow control;
- define subscriber delta baselines or frontend recovery behavior;
- build the TypeScript client model or presentation surface;
- delete the legacy replay path before consumers can migrate; or
- reintroduce row-count retention or a second terminal dependency.

## Acceptance criteria

1. Production runtime tests feed representative PTY traces through
   `RuntimeActor` and assert owned active screen, alternate screen, history,
   graphemes, host occupancy, style, colors, wrap, cursor, links, prompts,
   modes, palette, selection, dirty state, and effects.
2. Projection values remain valid after Ghostty mutates again, with no borrowed
   dependency value escaping the projection call.
3. The semantic path from `handle_output` produces no child-output payload and
   no ANSI replay. Any remaining raw event is explicitly legacy and owned by
   the area-05 switch.
4. Resize and theme tests prove ordered semantic transitions, host reflow, and
   preservation of child-authored palette/default state without reconstruction.
5. Interleaved input, output, terminal replies, effects, and exit preserve
   actor order. Occurrence effects are not collapsed into screen state.
6. Key, composed text, paste, mouse, focus, and application commands are encoded
   from active Ghostty modes and reach the PTY without browser-generated VT.
7. Selection tests cover gesture extension, autoscroll, wrapping, alternate
   screen, and retained history, not only word, line, and range helpers.
8. OSC 9 has one approved disposition and a production-path test. No frontend
   handler or raw forwarding is required by the semantic path.
9. The compatibility and retention suites pass unchanged, and no row-based
   retention authority is added.
10. A deliberate dependency fixture that changes an exposed semantic fact
    fails the production projection or compatibility gate rather than silently
    producing stale state.

## How to validate

Run focused backend tests first, then the repository gates:

```sh
cargo test --manifest-path core/backend/Cargo.toml terminal::compat
cargo test --manifest-path core/backend/Cargo.toml terminal::retention
cargo test --manifest-path core/backend/Cargo.toml terminal::
just test rust
just check all
just modularity boundaries
```

Add production actor scenarios for active and alternate screen, resize, theme,
history eviction, Unicode occupancy, input modes, selection, ordered effects,
OSC 9, replies, and exit. A green test that calls only `compat.rs` does not prove
this gate; at least one assertion for every required fact must traverse the live
runtime projection.

Capture projection cost and retained-memory behavior under representative
traces. Report measurements without inventing an acceptance threshold. Any gate
derived from them must cite the relevant product or technical authority.

## Stop and rollback

Stop before area 02 protocol freeze if Ghostty cannot expose a required fact,
input mode, selection operation, cell occupancy, or ordered effect. Return the
smallest falsifying production trace and dependency options for an owner
decision; do not keep xterm as an exception.

This area is additive while the legacy path remains. Rollback before cutover
removes the semantic projection and commands through the sole area-05 migration
switch. It does not create another parser or a transport-specific terminal
model.
