# Semantic frame transport is versioned and measured

## Outcome

Create one versioned semantic attachment protocol from the host-owned Ghostty
projection to every Shipctl client, prove its ordering and recovery rules, and
measure a binary Tauri transport before the client model or presentation
surface depends on it.

Raw PTY output is not the new frontend wire format. The raw-binary work in the
preparatory plan is superseded for output: changing decimal JSON bytes into
faster PTY bytes would optimize the xterm parser path that area 5 removes.

## Context and purpose

Current Tauri attachment events serialize `Vec<u8>` through serde into JSON
number arrays. The instance control socket separately base64-encodes the same
bytes, and TypeScript manually mirrors the Rust event union. Recovery carries
ANSI reconstructed from Ghostty state.

Tauri 2.11.5 can send `InvokeResponseBody::Raw` through a channel and can
accept raw invoke request bodies. A `Channel<Vec<u8>>` is not raw; its blanket
serde implementation remains JSON. The pinned Tauri implementation also uses
a different delivery path for small raw channel bodies, so burst-only tests
cannot establish real behavior for normal terminal frames. Encoding, batching,
backpressure, and frame size must be selected from measurements of the actual
packaged application.

The transport must represent terminal meaning rather than Ghostty memory.
Ghostty dirty rows help produce deltas, but Shipctl owns the wire schema,
subscriber baselines, revisions, invalidation, and loss recovery.

## Affected areas

- `core/backend/src/terminal/types.rs`, a new semantic protocol/codec module,
  `runtime.rs`, `service.rs`, and `commands.rs`;
- `core/backend/src/instance/protocol.rs` and `control.rs`;
- `core/frontend/platform/tauri.ts` and terminal protocol types/decoder;
- the DOM-free attachment controller and client cell model introduced in area
  3;
- `cli/src/terminals.rs` and `cli/src/instances.rs`;
- module-facing terminal session adapters; and
- cross-language fixtures, malformed-frame tests, runtime benchmarks, and
  packaged-app validation.

## Work to be done

### 1. Define one semantic domain protocol

Keep one Rust domain model for terminal attachment state. Transport DTOs may
differ where Tauri, JSONL control, and an interactive CLI have different wire
constraints, but every adapter must be exhaustive over the domain model. A new
domain variant fails compilation or contract tests until Rust transports and
the TypeScript decoder handle it.

Every state-bearing envelope includes:

- protocol version and frame kind;
- terminal ID and attachment identity/generation where required;
- non-zero consecutive stream sequence;
- resulting state revision; and
- base revision for any frame that depends on prior client state.

Terminal ID is sufficient under the current non-reused runtime-UUID contract;
do not add an incarnation field without a terminal-survival requirement that
can reuse an ID across host processes.

### 2. Specify snapshots, deltas, history, effects, and lifecycle

A complete screen snapshot contains all state required to replace the client
model atomically: geometry; active screen; semantic rows/cell runs; graphemes;
wide and continuation facts; style and color references; wrap state; cursor;
palette/default-color state; renderer-relevant modes; and history availability
and eviction bounds. It does not contain all retained history.

A screen delta declares its base and resulting revisions. It carries changed
rows or runs and any changed cursor, geometry, screen, palette, or mode facts.
Structural changes that invalidate the baseline produce an explicit complete
screen frame rather than an ambiguous partial delta. The exact invalidations
come from area 1 fixtures.

History is a separate revisioned request/response protocol. The controller
requests a window using a host-defined stable anchor and viewport intent; the
response identifies its source revision and retained bounds. Stale and evicted
anchors are explicit outcomes that trigger a refetch or user-visible loss
state, not guessed row offsets. Live snapshots do not grow with the selected
retention policy.

Measure window latency and define the client state exposed while an initial
window or refetch is in flight. Area 3 implements that state and area 4 paints
it. Blank, stale, or shifting rows cannot emerge as an accidental transport
side effect; any visible compromise requires the product contract and evidence
that authorizes it.

Effects and lifecycle are ordered alongside state but remain semantically
distinct. Screen state may be coalesced only when the resulting frame bridges
a valid baseline. Bell, notification, clipboard, exit, and other occurrence
effects are not silently collapsed into the latest screen.

### 3. Prove atomic bootstrap and recovery

Inside the serialized runtime actor, capture sequence/revision boundary `N`,
register the subscriber, enqueue its complete snapshot, and only then release
later events. Delivery that begins before the attach invoke resolves remains
ordered.

On sequence loss, base-revision mismatch, malformed state, or subscriber
overflow, request one recovery snapshot and suppress duplicate recovery work.
Install it atomically, discard frames covered by its boundary, hold later
frames, and resume only from the declared next sequence/revision. A malformed
or unsupported frame fails before any partial model mutation.

Derive mailbox and frame limits from the existing product flow contract,
measured frame sizes, acceptable latency, and memory evidence. Do not carry the
current raw-byte budget into a cell protocol merely because it already exists.

### 4. Select and prove the Tauri encoding

Prototype the semantic schema with the smallest stable encoding candidates
that have maintained Rust and TypeScript implementations. Measure encoded
size, allocation, encode/decode time, main-thread work, interaction latency,
sustained output, recovery, and malformed-input rejection in the packaged app.
Select one codec from that evidence and freeze golden fixtures.

Use `Channel<InvokeResponseBody>` with `InvokeResponseBody::Raw` for binary
screen delivery. Verify the actual JavaScript value and cost for both the
pinned Tauri small-body path and larger fetch-backed bodies. Derive batching or
coalescing policy from the measured workload; do not invent a frame duration,
size threshold, or improvement target.

Represent frontend input as versioned semantic commands: key, composed text,
paste, mouse, resize proposal, selection gesture, viewport request, and
application preset. Choose raw or structured invoke encoding per command from
measurement and payload needs, but do not expose arbitrary PTY writes to the
view. Text and paste preserve exact UTF-8 payloads; keyboard and mouse modes
are resolved only by the host.

TypeScript represents wire `u64` values without loss and checks lengths,
dimensions, table indices, revisions, and allocation bounds before publishing
a frame to the controller.

### 5. Preserve transport-specific consumers without a second authority

The control socket may keep stable JSONL framing and base64 for binary payloads
inside its explicit adapter. It must carry the same semantic attachment
meaning and pass the same exhaustive coverage and golden-fixture tests.

`shipctl terminals attach` currently writes raw PTY output and host-formatted
ANSI replay into an external terminal. Prototype a CLI presentation adapter
that consumes semantic frames and paints the authoritative cells to that
terminal without parsing PTY output. Prove interactive behavior, cursor,
alternate screen, resize, scrollback expectations, signals/job control, and
raw/NDJSON command modes before selecting its cutover in area 5. The external
terminal necessarily interprets paint control sequences, but it is not allowed
to reconstruct canonical state from the child PTY stream.

If that compatibility contract cannot be met, stop with evidence for an owner
decision. Do not leave raw output and ANSI replay undocumented while claiming
global single-VT closure.

### 6. Run a shadow migration without adding another permanent path

Behind the one migration switch, publish semantic frames to a shadow client
model while the old xterm path remains visible. Compare the model and visible
surface against the area 1 corpus and live workloads. New terminal capabilities
land only on the semantic domain model and are adapted to the legacy path only
when required to keep the temporary oracle usable.

Do not mix a semantic live stream with ANSI bootstrap, or raw live output with
a semantic baseline. The semantic path is internally complete before area 3
adopts it, and the legacy path is deleted as a unit in area 5.

## Acceptance criteria

- One Rust semantic model defines screen state, history, effects, lifecycle,
  and semantic input; adapter coverage fails on an omitted variant or field.
- Versioned snapshot and delta fixtures round-trip between Rust and TypeScript,
  including sequences/revisions beyond JavaScript's safe integer range.
- Applying any valid delta corpus to its declared baseline yields the same
  client state as the corresponding complete snapshot.
- Reordered, duplicated, stale-base, truncated, oversized, invalid-index, and
  unsupported-version frames fail without partial mutation and request at most
  one recovery where recovery is valid.
- Bootstrap and recovery preserve the declared sequence/revision boundary even
  when channel delivery begins before the attach call resolves.
- History windows are revisioned and bounded independently of total retained
  history; stale and evicted anchors have tested outcomes.
- The measured history-window contract defines in-flight client state and the
  surface never invents blank, stale, or mixed-revision rows.
- Occurrence effects remain ordered and are not lost by state coalescing.
- Packaged-app measurements cover both Tauri raw delivery paths, interaction
  traffic, sustained output, recovery, and the selected batching behavior.
- The selected limits and batching policy cite their technical contract or
  measured derivation.
- The webview semantic path exposes no `readonly number[]`, `Array.from(bytes)`,
  base64, raw PTY output, ANSI replay, or frontend escape parser.
- The control socket, CLI, and module adapters preserve their approved public
  contracts while deriving terminal state from the semantic authority.
- Only one temporary migration switch selects the visible legacy or semantic
  path; the shadow path creates no new independent VT state.

## How to validate

Run Rust codec and actor-order tests, TypeScript decoder/model tests,
bidirectional golden fixtures, malformed-frame/property tests, control-socket
compatibility tests, and CLI raw/NDJSON characterization tests. Exercise the
real Tauri command/channel implementation in a packaged macOS build.

Use the same checked-in workload corpus for JSON-versus-selected-codec evidence
and for snapshot-versus-delta state equivalence. Report measurements; do not
turn an observed percentage into a gate unless an owner or technical contract
authorizes it.

```sh
cargo test --manifest-path core/backend/Cargo.toml terminal
cargo test --manifest-path core/backend/Cargo.toml instance::control
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalProtocol.test.ts \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts
just test fast
just test rust
just test full
just build app
markdownlint docs/plans/top-5-single-vt-closure/*.md
git diff --check
```
