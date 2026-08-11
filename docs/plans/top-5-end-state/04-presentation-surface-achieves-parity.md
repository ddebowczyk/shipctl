# Presentation surface achieves parity

## Outcome

Shipctl has presentation-only adapters for both product surfaces:

1. a webview cell surface that paints and interacts with the persistent client
   model; and
2. a CLI painter that turns semantic state into local terminal presentation.

Neither adapter receives or parses the child's PTY stream. Neither decides
terminal modes, Unicode column occupancy, reflow, history, or selection
meaning. The webview translates browser interaction into semantic commands. The
CLI may generate ANSI locally for the caller's terminal, but that presentation
never becomes Shipctl's canonical state.

The webview consumes the model from
[area 03](03-client-model-owns-terminal-continuity.md). The CLI painter consumes
the semantic protocol from
[area 02](02-semantic-protocol-reaches-every-client.md). Both presentation paths
must pass before the global cutover in
[area 05](05-cutover-deletes-the-second-vt.md).

## Context and purpose

xterm currently supplies far more than pixels:

- `TerminalView.tsx` creates xterm and Fit, Unicode 11, Web Links, and WebGL
  addons;
- `term.onData` turns browser input into terminal bytes using xterm modes;
- xterm handles screen and history state, cursor, wrapping, width, selection,
  links, focus, and clipboard interaction;
- the view registers bell and OSC 9 notification behavior;
- replay resets xterm and feeds it reconstructed ANSI;
- the hidden-xterm probe in `terminalXtermMeasure.ts` calculates geometry with
  `FitAddon`; and
- `terminalOutputQueue.ts` drains byte chunks into `term.write`.

Five xterm packages remain in `package.json`: the core package plus Fit,
Unicode 11, Web Links, and WebGL addons. Imports are spread across the view,
renderer selection, addons, measurement, cache, viewport, theme, and output
queue modules.

Area 03 removes durable state from the widget. This area replaces the remaining
presentation and browser-integration capabilities without smuggling terminal
authority into a renderer cache or input adapter.

## Dependencies and gate

Webview integration requires area 03's stable model and semantic commands. CLI
presentation requires area 02's semantic records and commands. Host-supplied
cell occupancy and selection operations come from area 01.

Capability inventory, Unicode painting, IME and accessibility probes, renderer
fallback, and CLI painter feasibility start early because any can falsify the
target surface. Gate 04 cannot pass until areas 01-03 pass on their respective
production paths.

Gate 04 passes when every declared product capability is implemented over
semantic state or removed by a named product-owner decision, with measured
packaged behavior and no target-path dependency on xterm facts.

## Affected live modules

### Webview

- `core/frontend/terminal/TerminalView.tsx`
  - replace xterm construction, parser handlers, raw input, reset/replay, and
    visibility-coupled integration with a thin surface host. The DOM lifecycle
    now lives in `terminalContainerBinding.ts` behind
    `TerminalContainerPorts`; what stays in the component is refs and effects
    that delegate.
- `core/frontend/terminal/terminalMeasure.ts`
  - already reduced to size policy over a `TerminalSizeProbe`. It survives the
    migration; what changes is which probe it is given.
- `core/frontend/terminal/terminalXtermMeasure.ts`
  - delete with the rest of xterm. Reached only through
    `core/frontend/terminal/browser.ts`, which exists to name the legacy side
    of area 05's deletion in one place.
- `core/frontend/terminal/terminalRenderer.ts`
  - select a Shipctl painter and fallback, not an xterm renderer.
- `core/frontend/terminal/terminalRendererAddons.ts`
  - lose xterm addon ownership; retain only renderer-independent diagnostics if
    useful.
- `core/frontend/terminal/terminalViewport.ts`
  - map model viewport intent to pixels without becoming history authority.
- `core/frontend/terminal/terminalTheme.ts`
  - map resolved semantic colors and application chrome to paint values without
    overwriting host terminal state.
- `core/frontend/terminal/terminalCache.ts`
  - cache presentation resources only. It cannot cache a second terminal model.
- `core/frontend/terminal/terminalOutputQueue.ts`
  - the xterm byte-write role disappears. Presentation may schedule committed
    damage, not terminal bytes.
- terminal styles and package dependencies
  - coexist with the legacy implementation until area 05 deletes xterm CSS,
    imports, packages, and lockfile entries.

### CLI

- `cli/src/terminals.rs`
  - replace direct `write_raw_replay` and raw-event painting on the semantic path
    with a local painter over semantic records.
- CLI input and terminal-control helpers
  - capture interaction and submit area-02 semantic commands while preserving
    declared signal, job-control, and error behavior.

## Work to be done

### 1. Freeze the capability register before implementation claims parity

Inventory every current terminal capability and give it one disposition:

- required and implemented;
- required but blocking;
- intentionally changed with a named product-owner decision; or
- absent from the current product and therefore outside this migration.

Cover at least:

- active and alternate screen, cursor shapes and visibility, wrap and reflow;
- combining marks, wide cells, variation and joiner sequences, and font
  fallback;
- resolved colors, themes, transparency, fonts, scaling, and window resize;
- links, hover and activation, selection, copy, paste, and history browsing;
- keyboard, custom keybindings, mouse modes, wheel, focus, composed text, and
  IME;
- bell, notification, title, working directory, clipboard effects, exit, and
  renderer failure; and
- declared accessibility and keyboard-focus behavior.

Do not add search or screen-reader live-terminal behavior merely because xterm
can support it. Include either only when current product evidence or a named
owner makes it a requirement. This migration cannot silently remove an existing
accessibility behavior.

The register is executable, not prose:
`core/frontend/terminal/scenarios/capabilityRegister.ts` carries one entry per
capability with a disposition and a proof, where a proof is a lane test, a
scenario id, a written manual procedure, or nothing.
`core/frontend/terminal/tests/terminalCapabilityRegister.test.ts` enforces the
loop in both directions: a claim of implementation must carry a proof, a
`changed` disposition must name its owner, a cited test file and a cited
procedure file must exist, and every scenario the catalog builds must be claimed
by some entry. A scenario that proves nothing is a demo, and the test says so.

This ordering is the point. Without a frozen register, coverage becomes whatever
somebody wrote a scenario for, which is the parity-by-assertion failure this
area opens by forbidding. The harness in step 1a is the instrument; the register
is the checklist that decides what the instrument must measure.

### 1a. Reach packaged-only capabilities by inverting control

Some criteria are properties of the shipped engine and cannot be reached from a
test process at all. The webview cannot be driven from outside on macOS, so it
drives itself: a dev-only harness inside the app runs the scenario catalog
against the live surface and returns an NDJSON transcript.

The pieces are `scenarios/scenarioContract.ts` (the record union),
`scenarios/scenarioRunner.ts` (sequential execution; a throwing scenario becomes
one failed result rather than a lost run), `scenarios/scenarioCatalog.ts` (the
scenarios themselves, over a `TerminalSurfaceProbe` port), and
`terminalScenarioHost.ts` (the composition root, outside `scenarios/`, where
the live xterm, WebGL, and Tauri wiring is allowed to exist).

Four constraints hold it in place:

- **Memory is sampled from the host, not the page.** WebKit exposes no
  `performance.memory`; that API is Chrome's. Process memory comes from the Rust
  side through the existing `get_memory_stats` command and is correlated by
  scenario id. Frame timing from `requestAnimationFrame` deltas inside the page
  is fine, because that is the page's own fact.
- **The seam inherits area 05's proof obligation.** A dev-only entry point that
  survives into a release bundle is a second entry point. The guard is a bare
  `import.meta.env.DEV` test so the bundler can fold it, and
  `just check release-bundle` builds and scans to prove the fold happened. The
  function-call form of that guard does not fold; that was verified by building
  both ways.
- **The import boundary is the evidence.** `just modularity boundaries` holds
  `scenarios/` to its ports through a `scenario-port-only` rule with a single
  recorded exception for the entry point's dynamic import of the host.
  Unenforced, the harness would prove convenience rather than authority
  placement.
- **State what it cannot falsify.** A self-driven scenario proves that something
  ran, did not crash, and recorded numbers. It does not prove the glyph was
  right. `unicode.glyph-fits-span` and `input.ime` therefore stay `manual`, with
  procedures in `docs/ops/terminal-glyph-review.md` and
  `docs/ops/terminal-ime-review.md`, and a test that fails if either is ever
  downgraded to a scenario proof — that downgrade would be a claim to have
  automated human perception.

No scenario applies a pass/fail threshold to a measured number. No authority in
this plan sets one, so the scenarios record and the owner decides.

### 2. Define a narrow presentation interface

The webview surface consumes an immutable model projection and committed damage
and exposes browser interaction as semantic coordinates or commands. Keep the
interface independent of the chosen Canvas, WebGL, DOM, or other painter so a
working fallback can use the same state.

The painter owns:

- pixel geometry and clipping;
- glyph rasterization inside host-provided cell spans;
- draw scheduling and presentation caches;
- cursor and selection visuals;
- link decoration and hit testing; and
- fallback and renderer diagnostics.

It does not own rows, history, modes, column width, reflow, terminal colors as
mutable state, or protocol recovery.

### 3. Preserve host-only Unicode occupancy

Every semantic row supplies exact occupied columns, including wide leads and
continuation or spacer cells. Cursor, selection, hit testing, wrap, and reflow
use those host columns.

Font and canvas measurement may size the grid and place a glyph inside its
supplied span. No frontend `wcwidth`, Unicode-version table, browser grapheme
segmentation, or measured text width may change the span.

Join the area-01 semantic corpus to presentation facts for combining marks,
wide cells, variation selectors, joiner sequences, ambiguous fallback glyphs,
and missing fonts. If a cluster cannot be painted inside the host span, stop or
record an approved presentation limitation; do not create a second width
authority.

### 4. Integrate browser input without VT encoding

Map browser interaction to semantic operations:

- keyboard events and application keybindings;
- composed text and IME lifecycle;
- paste intent and clipboard reads;
- pointer press, drag, release, autoscroll, and multi-click selection;
- mouse reporting, wheel, modifiers, and focus; and
- link activation and application actions.

Use host cell coordinates for hit testing and area-01 operations for selection
meaning and mode-aware input. The browser cannot call xterm's input encoder or
construct arbitrary terminal escape sequences.

### 5. Render model, history, and effects

Paint active or alternate screen and requested history windows from the area-03
model. Respect viewport intent and missing-window states without fabricating
rows. A hidden tab receives no paint work while its model continues updating.

Dispatch occurrence effects through application integrations exactly once,
independent of frame coalescing and surface visibility. Effects that require a
user gesture, such as clipboard access, must expose a declared outcome rather
than disappearing. Shipctl refuses OSC 52 clipboard writes with one visible
notice. It does not request clipboard permission or apply the write.

Only host-marked OSC 8 hyperlinks are active. Plain-text URL auto-detection is
an approved product removal for the semantic terminal; no client or host URL
matcher is added.

Theme and font changes rebuild presentation resources and repaint current
state. They do not change model identity or request replay.

### 6. Provide a measured renderer and working fallback

Select the primary painter using representative packaged-app evidence. Measure
sustained output, frame behavior, memory, resize, scrolling, selection, hidden
catch-up, Unicode glyphs, and a cache-missing history window.

Implement a working fallback that presents the same semantic model after GPU or
primary-renderer failure. A blank terminal, xterm fallback, or permanent second
model fails this gate.

Derive performance gates only from recorded product requirements or technical
contracts. Report measurements even when no authorized threshold exists.

### 7. Build the CLI semantic painter

Consume area-02 semantic snapshots, deltas, history, effects, and lifecycle.
Generate local control sequences needed to update the caller's terminal. Those
sequences originate from Shipctl semantic state and never contain replayed child
output.

Characterize and preserve or explicitly change:

- cursor and alternate-screen behavior;
- local resize and scrollback expectations;
- interactive key, paste, mouse, and focus commands;
- signals and job control;
- raw presentation semantics; and
- NDJSON output and error behavior.

The external terminal necessarily interprets the locally generated presentation
stream. It is not a second VT authority inside Shipctl because it neither
receives the child stream nor supplies Shipctl's canonical model.

## Boundary exclusions

This area does not:

- parse child output or replay ANSI;
- decide Unicode columns, wrap, reflow, cursor columns, modes, history, or
  selection meaning;
- mutate the area-03 client model from renderer caches;
- define semantic wire DTOs or transport flow control;
- own the migration switch or cut over consumers; or
- delete the legacy xterm path before area 05.

## Acceptance criteria

1. The semantic webview surface imports the area-03 model and commands but no
   xterm parser, model, input encoder, Unicode table, or terminal addon.
2. The capability register has no unimplemented and unapproved current product
   requirement. Every accepted change names its product owner and updated
   contract.
3. Fixed semantic fixtures produce fixed presentation facts for active and
   alternate screen, cursor, wrap, colors, links, selection, history, effects,
   and lifecycle independently of the host parser fixture tests.
4. Combining marks, wide cells, variation and joiner sequences, and fallback
   fonts preserve host-supplied occupancy. Frontend measurement cannot alter
   columns, cursor, selection, wrap, or reflow.
5. Keyboard, custom keybinding, composed text, IME, paste, mouse, focus,
   selection, autoscroll, and link scenarios submit semantic commands and never
   browser-generated VT bytes.
6. Hide, show, theme, font, resize, renderer recreation, and renderer failure
   preserve model identity and use repaint rather than replay or recovery.
7. The fallback remains usable after a deliberate primary-renderer failure and
   does not instantiate xterm or a second terminal model.
8. Selection, copy, paste, links, clipboard effects, bell, notification, title,
   working directory, and exit have declared visible or typed outcomes.
9. Packaged-app measurements cover sustained output, frames, memory, resize,
   scroll, history-window miss, hidden catch-up, and fallback. Every applied
   gate cites an authority rather than an invented threshold.
10. The CLI painter attaches, paints semantic state, handles interactive input,
    resize, cursor, alternate screen, signals, job control, raw presentation,
    NDJSON, effects, and exit without child output or replay bytes.
11. A deliberate occupancy mismatch, missing required capability, renderer
    failure, or raw-byte injection fails the relevant parity or negative test.
12. xterm remains only on the legacy side of the area-05 switch and as a
    comparison oracle. No target-path fact is read from it.

Five of these were read as blocked on browser capability: 4, 5, 6, 7, and 9.
They are not one problem, and treating them as one is what made a browser lane
look necessary. Each reaches its proof by a different route:

- **5 and 6** are logic, not presentation. Command submission, hide and show,
  theme, font, resize, and renderer recreation move behind ports in area 03 and
  are proved in the existing Node lane against structural fakes. No DOM.
- **7** — fallback after a real renderer failure — is a scenario.
  `renderer.primary-failure` injects a failure at the Canvas2D target boundary,
  rebuilds presentation resources from the same model, and records whether the
  surface stayed usable. It does not depend on a WebGL context that the primary
  renderer does not use.
- **9** is a scenario plus a host sample: `measure.sustained-output` for frames
  and buffer growth, `get_memory_stats` for process memory.
- **4** does not fully reduce to either. A scenario can prove that the corpus
  painted, that host spans were the ones used, and that nothing threw; only a
  reader can prove the mark landed on the right base glyph. That part is the
  recorded residue, and it is `docs/ops/terminal-glyph-review.md`. The same
  split applies to real IME composition under criterion 5.

That residue is the explicit owner decision this area asks for: two perceptual
facts, each with a written procedure and a register entry, rather than an
implied gap.

## How to validate

Run component, interaction, CLI, and packaged-product scenarios, followed by
repository gates:

```sh
just test fast
just test rust
just test full
just check all
just check release-bundle
just modularity boundaries
```

Then run the packaged scenario harness in a dev build and file its NDJSON
transcript in `research/`, dated. Run the two manual procedures on each shipped
platform and file those results the same way.

Add focused frontend tests for renderer-independent facts, hit testing,
host-defined spans, IME, selection gestures, history windows, effects, viewport,
fallback, and surface lifecycle. Run a real packaged Tauri scenario so browser,
font, GPU, clipboard, focus, and IME integrations are exercised.

Know which lane each of those tests can run in before writing one. The frontend
lane is `pnpm exec node --test` over `.ts` through Node's type stripping. It
cannot parse JSX, and that is deliberate rather than incidental:

```sh
sed -n '5,8p' core/frontend/terminal/index.ts
```

The comment states that React components are deliberately not exported, because
mixing views into the entry point would make the capability's logic untestable
in those lanes. The tree matches: no `.test.tsx` exists and no test imports a
`.tsx`. `package.json` carries no vitest, jest, jsdom, happy-dom, React
renderer, playwright, puppeteer, or webdriver, and the decision below is that it
must stay that way.

So the working pattern is logic in `.ts`, xterm as an erased `import type`, and
a structural fake. `terminalRenderer.ts`, `terminalTheme.ts` and
`terminalOutputQueue.ts` take xterm as a type and are tested against fakes
today.

An earlier revision of this section claimed that `terminalMeasure` "needs a DOM
and nothing else". That was wrong, and the way it was wrong matters more than
the fact. `terminalMeasure.ts` value-imported xterm, xterm ships UMD, and Node
ESM cannot named-import it — so the module could not load in the lane whatever
`document` was present, and neither could `@shipctl/core/terminal`, because the
entry point re-exported it. The capability's own entry point had never been
loaded by the lane it claims to serve. A DOM would not have found that; loading
the module did.

The correction is a split, not a dependency:

- `terminalMeasure.ts` is pure size policy over an injected `TerminalSizeProbe`.
  It loads and is tested in the lane.
- `terminalXtermMeasure.ts` holds the hidden-xterm probe and stays out of the
  entry point. It reaches consumers through `core/frontend/terminal/browser.ts`,
  which names the legacy side of area 05's deletion.
- The React lifecycle facts — engine start, resize observation, gesture
  binding, reveal, and dispose order — are extracted to
  `terminalContainerBinding.ts` behind `TerminalContainerPorts` and tested in
  the lane against structural fakes. `TerminalView.tsx` keeps refs, two divs,
  and two effects that delegate.

**Decision — no DOM emulator enters the frontend test lane.** A happy-dom
dependency was added and then backed out. The reason is not dependency size. A
DOM emulator answers none of criteria 4, 7, or 9: those are properties of
WKWebView, WebKitGTK, and WebView2, and an emulator's answers about occupancy,
layout, hit testing, or focus would not be the shipped engine's answers. Having
one in the lane invites those questions to be answered by an authority that does
not count — a second presentation authority, the same defect as the second VT,
one layer up. Playwright is excluded for the same reason on the same evidence:
its WebKit is not WKWebView, and `tauri-driver` has no macOS support because
Apple ships no WKWebView WebDriver.

The residue that genuinely needs the packaged app is reached by inverting
control instead: the app runs its own scenarios. See the capability register and
scenario harness below.

Add CLI integration scenarios through the control socket for semantic attach,
resize, interaction, raw presentation, NDJSON, effects, disconnect, and exit.
Verify that captured local painter output derives from semantic fixtures rather
than matching child input bytes.

Compare the legacy and semantic paths during migration, but judge target
correctness against the host semantic contract and independent presentation
facts. xterm output is diagnostic evidence, not the specification.

## Stop and rollback

Stop area-05 default cutover if a required capability is missing, host cell spans
cannot be presented without local occupancy decisions, the fallback is unusable,
or measured packaged behavior violates an approved constraint.

Stop for an owner decision if CLI compatibility requires literal child-byte
identity or a current accessibility, IME, signal, or job-control behavior cannot
be implemented over semantic state.

Before cutover, rollback selects the unchanged legacy presentation through the
sole area-05 switch. The semantic surface cannot add its own xterm fallback or
per-renderer feature flag. After final deletion, rollback is a source rollback
that reruns the same parity and conformance gates.
