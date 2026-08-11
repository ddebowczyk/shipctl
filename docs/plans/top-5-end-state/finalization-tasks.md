# Semantic terminal finalization tasks

## Outcome

Finish the semantic terminal presentation path without adding another terminal
architecture, protocol, renderer, or performance program. When this plan is
complete, every blocking entry in the terminal capability register has a proved
outcome and the legacy implementation can be removed by
[cutover-tasks.md](cutover-tasks.md).

This is the minimum finalization scope. A task belongs here only when deleting
it would leave one of the eight current blockers unresolved.

## Current facts

- The webview already selects the semantic transport in
  `core/frontend/terminal/terminalBrowserSession.ts`.
- Protocol version 10, the host VT, the persistent client model, the Canvas2D
  surface, semantic input, selection, history, and occurrence-effect delivery
  already exist.
- `just test full` passes. The packaged semantic run recorded four passes, no
  failures, and one skipped WebGL loss probe.
- The current blockers are the eight entries listed under Area 04 in
  `interlude-handoff.md`.
- The sampled 770 ms frame gap has no authorized threshold and no attributed
  terminal cause. It is not a finalization task.

## Configuration decision for unsafe paste

Unsafe-paste confirmation is optional. Shipctl's existing global YAML file is
`~/.shipctl/config.yml`; do not create a second `config.yaml` or a new settings
store. Add this terminal setting to the existing file:

```yaml
terminal:
  confirmUnsafePaste: false
```

`false` preserves direct paste. When the value is `true`, safe text is sent
without interruption and text that the host classifies as unsafe requires an
explicit Paste or Cancel decision. No Settings-panel control is required.

## Non-goals

- No more profiling or performance thresholds.
- No protocol redesign or new screen representation.
- No second renderer, terminal model, or VT.
- No client-side terminal parsing, input encoding, width calculation, or URL
  matching.
- No screen-reader live region or terminal search feature. The capability
  register already records these as absent, not blocking.
- No legacy deletion in this plan.

## Execution order

Tasks F1 through F4 can be implemented independently. F5 depends on F1 through
F4. F6 depends on F5. Cutover starts only after F6 passes.

## F1 — Add configurable unsafe-paste confirmation

### F1 purpose

Close `input.paste` without forcing confirmation on users who do not want it.
The host remains the authority for whether pasted text is safe.

### F1 work

- Add `confirmUnsafePaste` to Rust `TerminalSettings`, the TypeScript settings
  contract, and the frontend default settings. Use `false` as the serde and
  frontend default so existing configuration keeps its current behavior.
- Persist the field through the existing terminal-settings load and save path.
- Expose `core/backend/src/terminal/input.rs::paste_is_safe` through the existing
  Tauri platform boundary. Do not copy its rule into TypeScript.
- At the browser composition boundary, inspect only semantic paste input. When
  confirmation is disabled, submit it unchanged. When it is enabled, ask the
  host whether the text is safe.
- Send safe text once. Hold unsafe text until the user selects Paste or Cancel.
  Paste sends the original text once; Cancel sends nothing.
- Use the existing notice action surface or another existing confirmation
  primitive. Do not add a terminal-specific dialog framework.

### F1 acceptance criteria

- Missing `confirmUnsafePaste` and explicit `false` both paste directly.
- With `confirmUnsafePaste: true`, safe text pastes directly.
- With `confirmUnsafePaste: true`, text rejected by the host does not reach the
  child before confirmation.
- Paste sends the exact original text once; Cancel sends no input.
- Bracketed-paste encoding remains a host decision based on the child mode.
- Focus, key, text, mouse, and composition input are unchanged.

### F1 verification

- Add Rust tests for configuration defaulting and YAML round-trip behavior.
- Add frontend tests for disabled, safe, confirmed, and cancelled paste paths.
- Run the focused terminal settings and semantic input tests.
- In the packaged app, test one safe paste and one multiline paste with the
  setting disabled and enabled.

## F2 — Complete real IME presentation

### F2 purpose

Close `input.ime`. The current hidden textarea accepts composition events, but
it stays at the container origin and does not present pre-edit text at the
terminal cursor.

### F2 work

- Position the editing host from the host-supplied cursor cell and current cell
  metrics so the platform candidate window opens at the terminal cursor.
- Present pre-edit text without committing it to the child or the terminal
  model.
- Clear pre-edit on commit and cancellation. Send committed text exactly once
  as semantic text input.
- Preserve active composition across repaint, theme change, and resize.
- Prevent application keybindings from consuming keys owned by an active
  composition.
- Keep all terminal meaning in the host. The IME overlay is temporary browser
  presentation state only.

### F2 acceptance criteria

- Every check in `docs/ops/terminal-ime-review.md` passes or has an explicit,
  owner-approved presentation limitation.
- Pre-edit and cancelled text never reach the child.
- Committed text reaches the child once and retains host-defined occupancy.
- No frontend VT bytes or width decisions are introduced.

### F2 verification

- Extend the synthetic composition tests for lifecycle and keybinding facts.
- Run `docs/ops/terminal-ime-review.md` in a packaged app with a real composing
  input method on every shipped platform.

## F3 — Replace the invalid WebGL probe with renderer recovery

### F3 purpose

Close `renderer.gpu-loss-fallback` against the renderer Shipctl actually uses.
The semantic surface uses Canvas2D, so a `WEBGL_lose_context` probe cannot prove
its failure behavior.

### F3 work

- Rename the capability and scenario from GPU loss to primary-renderer failure.
- Add a deliberate failure seam at the Canvas2D target or surface boundary.
- On failure, dispose and recreate presentation resources from the same
  `TerminalClientModel`. Do not reattach, replay, instantiate xterm, or create a
  second model.
- If recreation also fails, show one user-facing failure with a retry action.
  A retry recreates presentation resources from the existing model.
- Remove the WebGL-context probe from the semantic scenario.

### F3 acceptance criteria

- A deliberate painter failure leaves the terminal usable after automatic
  recreation or one explicit retry.
- Model identity, terminal identity, sequence, history, selection, and viewport
  intent survive the failure.
- No xterm or second terminal model appears on the recovery path.
- The packaged scenario runs and does not skip because a WebGL context is
  absent.

### F3 verification

- Add a focused presenter or surface test with an injected target failure.
- Run the corrected packaged renderer-failure scenario and record its result.

## F4 — Declare the remaining effect and link outcomes

### F4 purpose

Close `effect.clipboard-write` and `links.plain-text` without creating optional
feature projects.

### F4 work

- For an OSC 52 clipboard-write request, show one informational notice that the
  request was not applied. Do not write to the system clipboard and do not ask
  for clipboard permission in this finalization.
- Preserve ordered, once-only effect delivery. Screen-frame replacement must
  not hide or duplicate the notice.
- Record the product decision that plain-text URL auto-detection is not part of
  the semantic terminal. Keep host-marked OSC 8 hyperlinks.
- Update the capability register and Area 04 documentation to state both
  outcomes. Do not add a client-side or host-side URL matcher.

### F4 acceptance criteria

- Every OSC 52 write has one visible refusal outcome and changes no clipboard.
- Bell, notification, title, directory, and exit behavior remain unchanged.
- OSC 8 links still decorate, hit-test, and open through the configured scheme
  allowlist.
- Plain-text URL detection is recorded as an approved removal rather than a
  blocking missing implementation.

### F4 verification

- Add a semantic-session test for one clipboard-write effect and one notice.
- Run the existing occurrence-effect and OSC 8 link tests.

## F5 — Complete the packaged human checks

### F5 purpose

Close the blockers whose truth depends on a real webview, platform input, font
rasterization, or human gesture.

### F5 work

- Run `docs/ops/terminal-glyph-review.md` and record the result.
- Run `docs/ops/terminal-ime-review.md` after F2 and record the result.
- Write one short packaged interaction procedure for:
  - keyboard entry into and escape from the terminal;
  - selection followed by the platform copy gesture; and
  - one real full-screen program using focus, resize, mouse, and scrollback.
- Run the procedure on every shipped platform and store dated evidence under
  `research/`.
- Fix only a reproduced failure. Do not turn a passing manual fact into another
  automated framework.

### F5 acceptance criteria

- `unicode.glyph-fits-span`, `input.ime`, `selection.copy`, and
  `a11y.keyboard-focus` have recorded passing evidence or an explicit approved
  limitation permitted by their procedures.
- The copied text is the host's selection text, including wrapped-line
  behavior.
- The terminal remains usable after hide, show, resize, and renderer recreation.

## F6 — Close Area 04 and freeze the cutover baseline

### F6 purpose

Prove that finalization is complete and stop adding presentation scope before
legacy deletion.

### F6 work

- Update `core/frontend/terminal/scenarios/capabilityRegister.ts` so none of the
  eight current entries remains blocking without its required proof.
- Update `interlude-handoff.md` with finalization results and links to recorded
  packaged evidence.
- Run the existing repository, contract, release-bundle, and modularity gates.
- Record the exact commit and packaged build that passed. This is the baseline
  for cutover.

### F6 acceptance criteria

- `blockingCapabilities()` returns an empty list.
- Generated Rust and TypeScript contracts and fixtures reproduce exactly.
- `just test full`, `just check all`, `just check release-bundle`, and
  `just modularity boundaries` pass.
- No task was created from the unattributed 770 ms sample.
- [cutover-tasks.md](cutover-tasks.md) is now unblocked.

## Stop condition

Stop finalization when F6 passes. New measurements, optional features, and
possible improvements fail this plan's necessity test unless they reproduce a
failure in one of the acceptance criteria above.
