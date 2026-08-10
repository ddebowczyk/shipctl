# Round 15: Host anchor and pressure audit

From: reviewer  
To: solution owner  
Round: 15 of 22  
Purpose: close O1-O3 and O7 at contract precision

## Ownership

I own only canonical rounds 13, 15, 17, 19, and 21. The solution owner owns
the even rounds and every file under `docs/plans/top-5-end-state/`. I modified
only this round and report target corrections for the owner to apply.

## Verdict

The host-anchor design is feasible, but the plans currently describe anchor
behavior without defining a safe serializable identity or its lifecycle. A
Shipctl anchor must be an opaque host-issued capability backed by a backend-only
`TrackedGridRef`; it cannot serialize the FFI handle or a row coordinate.

The O1 PTY-reply correction is sound in the current target documents. One
remaining correction is needed: freeze the full client-visible event taxonomy
so descriptor changes and protocol-control outcomes are not lost while the
parser effects are redesigned.

OSC 9 is no longer an open three-way choice. The named operations page records
an approved upstream-first, local-binding-patch fallback. The area-01 plan is
stale where it still says that page contains contradictory start conditions
and where it asks implementation to choose among three outcomes.

Area 02 requires measurement but does not yet require all four facts needed to
make pressure safe: observable pressure at every bounded stage, whole-
transaction admission, an explicit lost-baseline outcome, and decoded-domain
equivalence across representations. These are necessary corrections; no
numeric limit is proposed here.

## Live and dependency evidence

I used `ast-grep outline` before focused reads of the live runtime, protocol,
controller, queue, and pinned Ghostty source.

- `RuntimeActor::handle_output` calls `VtReplayEngine::feed`, then sends the
  returned bytes only through `RuntimeActor::write_response` to the child.
- `RuntimeActor::publish` uses a per-attachment bounded mailbox and a separate
  control lane. A full mailbox sends `ResyncRequired` and removes that
  subscriber without blocking the parser or fast subscribers.
- The control socket is nonblocking. Socket pressure detaches that subscriber
  rather than adding a queue or blocking PTY draining.
- `terminalOutputQueue.ts` has a second renderer-side byte queue. It clears its
  pending bytes and requests replay on overflow.
- `TrackedGridRef` is owned, tied to one terminal and the screen/page-list that
  was active when set, follows scrolling and resize/reflow, and reports
  `None` after loss. It cannot disclose why the location was lost.
- `TrackedGridRef::set` may move a reference to the then-active screen. Each
  reference adds bookkeeping to terminal mutations; the dependency explicitly
  says to use them sparingly.
- Dependency tests prove scroll following, reset invalidation, terminal-drop
  invalidation, and cross-terminal rejection. They do not prove Shipctl wire
  identity, eviction classification, alternate-screen behavior, or concurrent
  request revisions.
- Ghostty callbacks are synchronous inside `Terminal::vt_write`. The safe API
  exposes bell, title, working directory, and clipboard callbacks plus
  child-response/query callbacks, but not the OSC 9 payload.
- `compat.rs` proves the order of title, bell, working-directory, clipboard,
  and PTY-reply callbacks inside one write. It also proves the OSC 9 gap.
- `TerminalEvent` separately carries metadata change, agent activity change,
  exit, resync, and detach. A semantic replacement must classify these too.

## Minimum serializable host-anchor contract

### Identity and backend binding

The wire reference needs only these Shipctl-owned identity facts:

- an opaque, losslessly encoded `anchor_id`, never reused within one terminal
  incarnation;
- the terminal runtime incarnation that owns the Ghostty instance;
- the attachment or lease identity that owns the anchor resource;
- primary or alternate screen identity plus a host screen generation; and
- the terminal state revision on every command and response that resolves the
  anchor.

The backend keeps the only map from that identity to `TrackedGridRef`. Raw
pointers, dependency objects, absolute row numbers, and current coordinates do
not cross the projection boundary. An attachment owns its anchor registry,
releases it on detach, and provides explicit release for anchors no longer in
use. A new attachment or terminal incarnation cannot present an old token.

No separate anchor-generation counter is necessary if IDs are never reused.
The terminal incarnation, attachment identity, and screen generation are the
required generations. Adding another counter without a distinct invalidation
job would violate MSW.

### Revision rule

An anchor follows mutations; it is not permanently pinned to its creation
revision. A history or selection command nevertheless names the model revision
against which the user formed it. The actor resolves the command atomically:

- if the named revision is current, resolution and the returned cells or
  selection transition share that revision;
- if it is stale, the actor returns a typed stale-revision result with no
  partial data or mutation; and
- a client applies a delayed result only if its returned revision still
  matches the model state required by that operation.

This is the minimum rule that prevents a window from combining rows from two
revisions. It does not require retaining historical terminal revisions.

### Mutation behavior

- Scroll and resize/reflow preserve the anchor ID when `TrackedGridRef` retains
  a value. The resolved coordinate may change; clients never treat a cached
  coordinate as identity.
- Switching active screens does not itself remap or invalidate an anchor. The
  reference remains tied to its owning primary or alternate page-list. A
  request for a different screen fails as a typed screen mismatch rather than
  resolving the same coordinates there.
- Reset or page-list replacement rotates the affected screen generation and
  invalidates its old anchors. An explicit host reset can name `reset`.
- When Ghostty reports only `None`, Shipctl reports a conservative
  `discarded_or_unavailable` reason. It must not invent `reset` or `evicted`
  from bytes by adding another parser.
- Eviction is explicit when the requested history range lies outside the
  authoritative retained boundaries or the host can otherwise prove pruning.
  Otherwise it uses the conservative unavailable result.
- Terminal replacement, attachment release, explicit anchor release, and
  terminal exit each have typed terminal outcomes. No invalid token silently
  falls back to current coordinates.

An inactive-screen result is not the same as invalidation. The host may serve
the owning inactive page-list if the dependency can prove it safely; otherwise
it returns `screen_inactive`. It never remaps the anchor to the active screen.

### Required anchor proof

The production corpus must cover:

- opaque identity round-trip and cross-terminal, cross-attachment, and stale-
  screen-generation rejection;
- scroll plus primary-screen reflow preserving identity;
- alternate-screen resize without local reflow and without cross-screen
  remapping;
- active-screen switches with both preserved and dependency-invalidated refs;
- reset, terminal replacement, explicit release, and detach;
- retained-history eviction and the conservative unavailable fallback;
- in-flight history results that become stale before the client applies them;
- two-endpoint selection extension over wrap, reflow, and history; and
- measured mutation and memory cost for the actual concurrently retained
  anchors, followed by a lifecycle policy derived from that evidence.

The plan must not preselect an anchor count or lifetime. Explicit release and
attachment cleanup are required independently of any later measured limit.

## OSC 9 containment and timing

The three abstract dispositions are bounded only under these interpretations:

1. Owned dependency support is valid because it produces the notification in
   Ghostty's synchronous effect order.
2. A bounded extractor would be valid only if its public output is OSC 9
   notification data, it holds no terminal state, it cannot alter bytes fed to
   Ghostty, and tests prove split, terminated, malformed, and non-OSC-9 input
   plus ordering among neighboring Ghostty effects. Without exact inter-effect
   ordering it is not an acceptable extractor.
3. Product removal is valid only as a named contract change before parity and
   cutover gates claim success.

That analysis no longer authorizes a choice. The current
`docs/ops/terminal-osc9-upstream-task.md` records the owner's decision:
upstream first, with the same binding change carried locally if needed. Filing
starts now because upstream latency is external. The notification payload
shape may freeze after that decision, but area 01 cannot pass and area 05
cannot remove xterm until production dependency support and its ordered-effect
test exist. If upstream has not merged when area 01 otherwise needs to pass,
the already approved local binding patch is the path; do not wait until after
area 04 has passed.

The extractor and product-removal branches are now stop-and-return options only
if the approved binding path is falsified. They require a new owner decision.

## Transport and pressure contract

### Observable stages

Measurements and diagnostics must identify pressure separately at:

- actor-to-subscriber admission;
- the Tauri channel or control-socket write boundary;
- client decode and atomic model commit; and
- history request and response work.

For each bounded stage, evidence records the representation being accounted,
current and high-water occupancy, accepted and rejected logical transactions,
the affected sequence/revision boundary, detach or recovery outcomes, and
drain behavior. Those observations are not limits. A selected limit still
needs the authority required by the plans.

### Atomic overflow

One actor mutation and its state delta plus ordered occurrence effects form one
logical transaction. Admission accepts the whole transaction or none of it. It
cannot queue cells while dropping the bell, notification, clipboard, lifecycle,
or descriptor event that shared the ordering boundary.

On rejection, that subscriber's baseline becomes unusable exactly once. Normal
delivery stops, no later delta is appended to the rejected base, and the client
receives an overflow/resync terminal outcome through the reserved control path
when writable. If the transport itself cannot carry that outcome, connection
closure is the explicit equivalent and the server records the pressure reason.
Either way, the client cannot continue as if its baseline were complete.

The outcome identifies the last accepted boundary and the first rejected
boundary wherever the transport remains available. Occurrence effects in the
rejected interval are declared undelivered; they are not silently described as
delivered or reconstructed from a later state snapshot. The host continues
parsing for other subscribers and preserves canonical state.

### Representation equivalence

Candidate Tauri structured or binary payloads, control JSONL or base64, and CLI
records must decode to the same Rust-domain fixtures. Equality is defined over
semantic values, ordering, lossless identities and counters, invalidation and
overflow outcomes, and validation errors, not serialized bytes.

Golden tests must encode one domain fixture through every selected
representation, decode it, and compare domain equality. They must also inject
the same malformed invariant and whole-transaction overflow at each adapter and
prove no representation partially mutates a model or changes the recovery
meaning. Transport-specific envelope failure may close a connection, but it
cannot create a different terminal state transition.

## PTY replies and client-visible event inventory

The corrected target is right: `on_pty_write` data is actor-to-child only.
Query providers for enquiry, XTVERSION, size, color scheme, and device
attributes are in the same child-directed class even when their safe callback
returns structured data before Ghostty emits reply bytes. None belongs in a
client effect union.

The semantic contract must exhaustively classify the current visible surface:

- parser-derived state transitions: title and working directory;
- parser-derived non-coalescible occurrences: bell, OSC 9 notification, and
  clipboard write with its declared application outcome;
- runtime-visible transitions: metadata change, agent activity change, and
  exit/lifecycle;
- protocol-control terminal outcomes: overflow/resync and detach; and
- actor-to-child only: parser PTY writes and terminal query responses.

Screen, history, cursor, modes, palette, links, prompts, and selection are
revisioned state, not occurrence effects. Link activation and user gestures are
semantic commands, not child effects. This taxonomy prevents both accidental
coalescing of occurrences and needless retention of state transitions as an
unbounded event log.

## MSW-passing target corrections

### C1: Make host anchors a real owned capability

Target:
`01-host-semantic-authority-is-production.md`, **Work to be done / 1. Define
the owned terminal domain** and **6. Keep history policy singular**; extend its
acceptance and validation sections.

Text intent: add terminal incarnation, primary/alternate screen generation,
opaque non-reused anchor ID, attachment ownership, explicit release, and
backend-only `TrackedGridRef` registry. State the mutation and conservative
invalidation rules above. Add production tests for reflow, alternate screen,
reset, eviction/unavailability, detach/release, stale revision, and anchor
resource cost. Do not serialize a dependency handle or coordinate as identity.

Target:
`02-semantic-protocol-reaches-every-client.md`, **Work to be done / 1. Define
one versioned semantic envelope** and **4. Preserve effects and history
semantics**.

Text intent: carry the anchor capability identity and request base revision;
define resolved, stale revision, wrong incarnation/attachment/screen, inactive
screen, released, evicted, and conservative unavailable outcomes. Require
delayed responses to fail atomically rather than mix revisions.

### C2: Replace the stale OSC 9 choice and clock

Target:
`01-host-semantic-authority-is-production.md`, **Dependencies and gate** and
**Work to be done / 5. Close the OSC 9 effect gap**.

Text intent: remove the claim that the operations page still has contradictory
start conditions. Record the approved upstream-first path, immediate human
filing, and already approved local binding patch if upstream is unavailable
when area 01 otherwise needs to pass. Binding support plus its production order
test is required before gate 01 passes. Treat extractor or product removal as a
new owner decision only if the selected path is falsified.

### C3: Freeze the complete visible-event taxonomy

Target:
`01-host-semantic-authority-is-production.md`, **Work to be done / 1. Define
the owned terminal domain**, and
`02-semantic-protocol-reaches-every-client.md`, **Work to be done / 1. Define
one versioned semantic envelope** and **4. Preserve effects and history
semantics**.

Text intent: classify title and working directory as revisioned visible state;
bell, notification, and clipboard as non-coalescible occurrences; metadata,
agent activity, and exit as ordered runtime-visible transitions; and
overflow/resync/detach as protocol-control outcomes. State that PTY writes and
all query responses remain child-directed and are absent from every client
adapter. Preserve one exhaustive union without forcing state changes into an
unbounded occurrence log.

### C4: Require observable, atomic, representation-equivalent pressure

Target:
`02-semantic-protocol-reaches-every-client.md`, **Work to be done / 3. Define
deterministic application and bootstrap**, **6. Select transport
representation from evidence**, and acceptance criteria 5, 7, 9, and 10.

Text intent: define whole semantic transactions, all-or-nothing queue
admission, a sealed baseline after overflow, the last accepted and first
rejected boundaries, reserved control notification or explicit transport-close
equivalence, and per-stage pressure observations. Add golden equality tests
across selected representations for semantic frames, lossless identities,
errors, invalidation, and overflow. Preserve slow-subscriber isolation and
forbid carrying current raw-byte queue limits into the new policy without new
evidence.

Target:
`03-client-model-owns-terminal-continuity.md`, **Work to be done / 2. Evolve
the existing controller as the one protocol writer** and acceptance criteria 2,
8, and 11.

Text intent: apply a logical transaction or overflow outcome atomically; after
overflow, reject later deltas until a new semantic baseline commits. Prove
effects are either delivered once in order or declared inside the undelivered
range, never silently lost while screen state advances.

## Claims rejected by MSW

- Serializing `TrackedGridRef`, its pointer, or its current coordinate is
  rejected; none is a stable cross-process identity.
- A permanent coordinate-to-row identifier is rejected; reflow is precisely
  why an opaque tracked capability is needed.
- A new numeric anchor cap is rejected; explicit release, detach cleanup, and
  measurements precede any authorized resource limit.
- Requiring every transport to use identical bytes is rejected; decoded domain
  equality is the contract.
- Requiring a recoverable occurrence-effect backlog without bound is rejected;
  explicit overflow declares an undelivered range and invalidates the baseline.
- Reopening the PTY-reply decision is rejected; live code and corrected plans
  already prove the actor-to-child boundary.

## Round-15 disposition

O1 is accepted subject to C3's exhaustive taxonomy. O2 is resolved as a chosen
dependency path, with C2 needed to make the plans match the owner record. O3 is
feasible once C1 defines opaque identity, ownership, invalidation, and revision
rules. O7 is feasible once C4 makes pressure observable and overflow atomic
and proves semantic equivalence across representations. No finding requires a
second VT authority.
