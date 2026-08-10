# Client model owns terminal continuity

## Outcome

The DOM-free terminal attachment owns a persistent, renderer-independent model
of semantic screen state, history, cursor, modes, palette, links, prompts,
selection projection, viewport intent, effects, and lifecycle.

The model remains attached and applies host updates when no surface is visible.
Hiding, showing, recreating, or changing the renderer rebuilds presentation from
the existing model; it does not detach, reset terminal state, or request an
unbased reconstruction.

This area consumes the versioned protocol from
[area 02](02-semantic-protocol-reaches-every-client.md) and supplies stable
state and commands to the webview surface in
[area 04](04-presentation-surface-achieves-parity.md). It evolves the existing
`TerminalAttachmentController`; it does not introduce a second attachment state
machine.

## Context and purpose

The controller enabler extracted generation, sequence-gap handling, reattach,
and input admission from the large React effect. Its current ports still expose
the legacy model:

- install a replay byte stream;
- release output bytes to `terminalOutputQueue`; and
- submit browser-generated terminal input.

`TerminalView.tsx` still supplies the durable terminal state through xterm. It
returns early while `visible` is false, includes visibility in the attachment
effect dependencies, and disposes the controller during effect cleanup. xterm
owns scrollback, viewport, selection, cursor, and canonical screen state.

That structure makes surface lifetime a protocol event. The semantic protocol
cannot remove xterm authority until a plain TypeScript model becomes the durable
recipient of host state.

The implemented lifecycle enabler remains authoritative:
`TerminalClientRuntime` is the one reducer for descriptors, tombstones, and
typed close or write outcomes. The attachment model consumes registry lifecycle
state; it does not create another registry writer.

## Dependencies and gate

Area 02 must provide decoded semantic snapshots, deltas, history windows,
effects, commands, lossless counters, and atomic bootstrap behavior. This area
may develop deterministic model traces against checked-in decoded fixtures in
parallel, but cannot pass against an invented local protocol.

Gate 03 passes when model identity and terminal continuity survive normal
surface and visibility changes, and recovery occurs only at the four accepted
boundaries:

1. initial attachment;
2. deliberate client-model loss or recreation;
3. sequence or base-revision mismatch; and
4. queue overflow.

Resize, theme, focus, visibility, and surface recreation are not recovery.

## Affected live modules

- `core/frontend/terminal/terminalAttachmentController.ts`
  - evolve byte and replay ports into semantic frame application, model access,
    effect delivery, history requests, and semantic commands.
- `core/frontend/terminal/terminalAttachmentBootstrap.ts`
  - preserve atomic attach ordering across invocation and channel races while
    establishing sequence and state revision together.
- `core/frontend/terminal/tests/terminalAttachmentController.test.ts` and
  `core/frontend/terminal/tests/terminalAttachmentBootstrap.test.ts`
  - retain trace equivalence for sequencing and add semantic model traces.
- `core/frontend/terminal/terminalClientRuntime.ts`
  - remain the descriptor and lifecycle authority; expose attachment creation
    or lifecycle input without absorbing model mutation.
- `core/frontend/terminal/terminalOutputQueue.ts`
  - lose its raw-byte and xterm-write role. Any semantic ingress queue belongs
    to the controller and uses area-02 flow-control rules.
- `core/frontend/terminal/TerminalView.tsx`
  - stop owning attachment lifetime, protocol state, replay installation, and
    visibility-driven detach. It becomes a surface subscriber in area 04.
- terminal capability exports and tests
  - export the model through the capability entrypoint without cross-capability
    imports into implementation files.

## Work to be done

### 1. Define a plain TypeScript model

Represent decoded semantic state without xterm, React, DOM, canvas, or WebGL
types:

- geometry, active or alternate screen, rows and host-supplied cell spans;
- retained history windows, anchors, boundaries, and eviction outcomes;
- cursor, modes, resolved colors, palette, links, and prompt metadata;
- projected selection and selected-content state;
- current sequence and state revision;
- pending or applied occurrence effects and lifecycle; and
- viewport intent, including follow-bottom and stable history anchor.

Model mutation is atomic. A frame either validates completely against sequence,
base revision, history anchors, and invariants and then commits, or leaves the
model unchanged.

The model never recalculates grapheme width, wrap, reflow, cursor columns,
selection meaning, or terminal modes.

### 2. Evolve the existing controller as the one protocol writer

Replace `installReplay` and `releaseOutput` with decoded semantic operations.
The controller owns:

- attachment generation and bootstrap;
- ordered frame validation and atomic model commits;
- gap, stale-base, overflow, and recovery transitions;
- history requests and delayed response handling;
- semantic command admission;
- once-only occurrence-effect delivery; and
- subscriptions that publish committed model changes or damage to surfaces.

Do not add a React hook, Zustand store, renderer cache, or
`TerminalClientRuntime` branch that can mutate the same terminal model.

### 3. Separate attachment, model, and surface lifetimes

Keep the attachment and model alive while a terminal tab is hidden. Suppress
only expensive DOM or renderer work when there is no mounted surface.

Surface mount receives the current model and subsequent committed changes.
Surface unmount removes that presentation subscription only. Surface recreation
repaints the complete current model without host recovery.

Deliberate model disposal is explicit and is the second accepted recovery
boundary. It cannot occur as an incidental React effect cleanup caused by
visibility, theme, font, renderer, or geometry props.

### 4. Preserve viewport and history intent

Store viewport intent in renderer-independent columns and semantic history
anchors:

- follow bottom while the user is pinned;
- preserve the viewed history anchor while new output arrives;
- request missing windows explicitly;
- handle eviction or invalidation using the declared protocol outcome; and
- keep delayed window responses from mixing revisions.

The model exposes a view projection to area 04. It does not fabricate blank
history rows and does not ask xterm for scroll state.

### 5. Make routine transitions ordered

- A surface requests a semantic resize after measuring geometry. The model
  changes when the ordered host resize transition arrives; it does not perform
  optimistic local reflow.
- Theme requests resolve through host palette/default state and apply as
  ordinary model transitions.
- Focus is a semantic command and mode effect, not an attachment reset.
- Hidden output updates the same model without paint.

Any presentation latency policy must preserve host ordering and cite an
area-02 flow-control or product contract.

### 6. Unify lifecycle and input readiness

`TerminalClientRuntime` remains the writer of terminal descriptor lifecycle.
The attachment consumes its current state once and combines it with attachment
readiness to expose a single typed input outcome.

A command racing exit must have one deterministic result. It cannot be silently
dropped by a view gate and independently rejected by the host. Occurrence
effects and exit remain ordered even with no mounted surface.

## Boundary exclusions

This area does not:

- parse ANSI or child output;
- encode PTY input or decide terminal modes;
- measure fonts, draw cells, hit-test pixels, or integrate IME and clipboard;
- define transport serialization or protocol limits;
- move descriptor registry ownership out of `TerminalClientRuntime`; or
- select the product migration path.

## Acceptance criteria

1. The model and controller import no xterm, React, DOM, canvas, or WebGL type
   and run in a plain TypeScript test environment.
2. Semantic snapshot, delta, history, effect, lifecycle, viewport, and projected
   selection state apply atomically. Wrong-base or invalid input cannot partly
   mutate the model.
3. Existing pre-extraction generation and sequence expectations remain valid
   where their semantics are unchanged; expectation edits require a named
   protocol change, not a convenient rewrite.
4. A trace hides the surface, applies output and effects, shows it again, and
   proves the same attachment and model identity with current state and once-only
   effect delivery.
5. Surface disposal and recreation preserve attachment, history, viewport
   intent, selection projection, and model revision without host recovery.
6. History traces prove delayed windows, eviction, resize invalidation, active
   screen changes, and stable viewed anchors without blank-row invention.
7. Resize, theme, focus, visibility, and surface recreation never enter the
   recovery state or request an unbased snapshot.
8. Recovery traces prove exactly the four accepted boundaries, including
   overflow and stale-base recovery, and no fifth routine trigger.
9. Input readiness has one client decision derived from attachment and
   `TerminalClientRuntime` lifecycle. Races with exit and close have one typed,
   deterministic outcome.
10. `TerminalView` no longer installs replay, releases byte output, or disposes
    attachment because `visible` changed on the semantic path.
11. `terminalOutputQueue` is absent from the semantic path. Any replacement
    queue stores decoded frames or committed damage and uses measured protocol
    policy rather than copied byte limits.
12. Deliberately applying an invalid frame or triggering visibility cleanup
    fails the trace suite, proving the atomicity and continuity gates can fail.

## How to validate

Run the controller, bootstrap, model, and lifecycle suites without a browser,
then the frontend and repository gates:

```sh
pnpm exec node --test \
  core/frontend/terminal/tests/terminalAttachmentBootstrap.test.ts
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts \
  core/frontend/terminal/tests/terminalClientRuntime.test.ts
just test fast
just check all
just modularity boundaries
```

Add deterministic traces for:

- early channel event plus attach resolution;
- snapshot and delta equivalence;
- hidden output and once-only effects;
- hide, show, surface recreation, and deliberate model loss;
- stale, duplicate, reordered, and wrong-base frames;
- history request, delay, eviction, and invalidation;
- resize and theme transitions;
- overflow and based recovery; and
- exit, input, close, and reconcile races.

Run at least one production Tauri attachment scenario with a real host frame to
prove the decoder and controller are connected. Fixture-only tests cannot prove
the live component stopped consuming raw output.

This extraction is also what makes the current view's behavior testable at all,
which is a second reason to sequence it before area 04.

```sh
ast-grep outline core/frontend/terminal/TerminalView.tsx
```

One interface and one exported function. The whole file is a single component
body, so every fact about input delivery, hidden-surface behavior, visibility
dependencies, and cleanup disposal is reachable only through a React lifecycle.
The frontend lane runs `pnpm exec node --test` over `.ts` through type
stripping and cannot parse JSX, so nothing in the repository executes any of
those facts today. Moving them into `.ts` behind a controller port puts them in
the lane that already exists, beside the fakes that
`terminalRenderer.test.ts` and `terminalOutputQueue.test.ts` use. Adding a JSX
and DOM toolchain to test them where they sit is the alternative this area
removes the need for. See area 04's validation section for the split between
what this extraction covers and what would still need an owner decision.

Measure model application, retained client memory, hidden-update cost, surface
catch-up, and history-window cache behavior. Report values without inventing
acceptance thresholds.

## Stop and rollback

Stop before area 04 integration if deterministic traces cannot preserve state
through hidden output, surface recreation, history eviction, resize, and the
four recovery boundaries without consulting xterm or the DOM.

Before cutover, rollback selects the legacy controller adapter through the sole
area-05 switch. It does not restore visibility-driven detach to the semantic
controller or create a second client model. After final cutover, rollback is a
source rollback governed by area 05, not a permanent runtime flag.
