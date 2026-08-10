# Claim inventory of the end-state plan

Every factual assertion about the tree in the six files of
`docs/plans/top-5-end-state/` at commit `4ffe209`, checked blind: no expected
value was requested from, or supplied by, the plan's author.

## Method, which is the part that transfers

State the method before the number, so the two can be attacked separately.

- **File exists** — `test -f`, printing PRESENT or ABSENT. A file that
  exists but holds no match cannot read as absent.
- **Symbol exists** — `rg --fixed-strings` on the definition form. No
  character class, so nothing can be excluded without notice.
- **Package set** — `jq` key enumeration with `startswith`. Never a regex;
  see the failure below.
- **Import spread** — `rg -l` over the capability directory, then subtract
  documentation by inspecting the file list.
- **Behaviour** — read the function body. **Insufficient.** See "The method
  that failed twice on behaviour" below.

### The failure that produced this table

Two method failures in one session, same defect class, opposite outcomes.

A check of the `just` recipes reported all five missing. The method was wrong —
`just --show` against submodule names. It was caught in seconds **because the
answer was surprising**.

A check of the `@xterm` package count used `"@xterm/[a-z-]+"`. The character
class excludes digits, so `@xterm/addon-unicode11` could never match. The count
came back as the expected number and survived, and an agreement that had not
been established was reported as established.

The only variable was whether the result agreed with the person running it.
**Verification self-corrects when it disagrees with you, and not otherwise.**
This is the argument for blind checking, and it is stronger than the usual one.

### The method that failed twice on behaviour

Reading a function body proves what the code *says*, not what the system *does*.
Two findings derived that way were refuted by test in one afternoon:

- A palette defect derived from `apply_theme` writing host defaults
  unconditionally. The call-graph reading was exact and the conclusion was
  wrong: libghostty-vt keeps the child's OSC 4/10/11 state in a layer *above*
  the host defaults. `compat.rs` already proved it in
  `the_child_owns_the_palette_and_the_default_colors`, forty lines from a test
  cited as evidence for the finding. Refuted by
  `a_theme_change_does_not_discard_colors_the_child_set_for_itself`
  (`replay.rs`), which passes against the unmodified engine and guards against
  a vacuous pass by proving the theme did reach the default layer.
- A claim that a replay carries only the active screen, so a resize costs
  history. Refuted: a replay re-encodes every retained row. The cost is
  re-encoding, not content loss.

Both were derived by careful reading. Care is not the missing ingredient.

## Result

**50 claims. 0 wrong. 0 unverifiable. 1 verified-but-ambiguous.**

The six files carry **zero** `file:line` anchors, confirmed by two independent
patterns over 1608 lines. A zero-anchor document scored better than either
anchored draft that preceded it: four anchor errors between those two, three of
them mine.

| Group | Count | Verdict |
| --- | --- | --- |
| Files named and present | 9 | verified |
| Symbols named and present | 10 | verified |
| Behaviour | 12 | verified as read; see proof status |
| Wire and type shapes | 5 | verified |
| Counts | 2 | verified |
| Tooling and recipes | 5 | verified |
| Bell, OSC 9, cache, tombstones, bootstrap buffer | 5 | verified |
| Renderer and port wiring | 2 | verified |

Counts, with the method that produced them: five `@xterm/` packages by `jq` key
enumeration; eight frontend modules importing them by `rg -l`, and the eight the
plan names are the same eight, not merely the same number.

### The one ambiguity

`runtime.rs` defines `resize` twice and `set_theme` twice — a `pub fn` on the
handle and a private `fn` on the actor. A symbol name alone yields two hits per
claim with no recorded way to choose. Verified, at a cost the notation does not
disclose. The command form dissolves it:
`rg -n 'self\.replay\(\)' core/backend/src/terminal/runtime.rs` → three hits, in
`resize`, `snapshot`, `set_theme`. The command shows which `impl` each hit is in,
so nobody has to choose between two functions named `resize`.

Resolved upstream at `62702b5`: area 01 now carries that command and its expected
shape in place of the symbol names, so the document re-proves its own premise.

## Proof status of the 12 behaviour claims

Location claims are cheap and both reviewers are now good at them. Behaviour
claims are what failed. Sorted by whether anything executes them:

### Executed (4)

- **`compat.rs` is test-only** — held by the **compiler**, not a test:
  `mod.rs` declares the module under `#[cfg(test)]`. Stronger than a test,
  because it cannot be satisfied at run time.
- **`compat.rs` proves the OSC 9 gap** — it is itself a named test,
  `the_desktop_notification_payload_is_not_exposed`.
- **`VtReplayEngine::replay` uses `format_active_screen`** — the
  `terminal::replay` suite calls `replay()` and asserts its output, so the
  path executes and its result is checked.
- **`terminalOutputQueue` drains chunks into `.write`** —
  `terminalOutputQueue.test.ts` drives it through a fake terminal that
  records every `write`, which is exactly what the claim states.

### Executed by nothing (8)

- **`handle_output` publishes the bytes it fed the engine** — drive
  `RuntimeActor` with a recorded PTY trace and assert the published `Output`
  payload is byte-identical to the input.
- **`RuntimeActor::resize` publishes a replay** — resize through the actor
  and assert one `TerminalEvent::Replay`, and no other reconstruction.
- **`RuntimeActor::set_theme` publishes a replay** — the same, through the
  theme path.
- **`terminalMeasure` builds a hidden xterm with `FitAddon`** — construct
  the measurer in a DOM environment and assert both the detached container
  and the addon load.
- **`term.onData` carries browser input** — mount the view, dispatch input,
  and assert the submitted payload.
- **The view returns early while `!visible`** — mount hidden and assert that
  no attachment work occurs.
- **`visible` sits in the attachment effect's dependencies** — toggle
  visibility and assert the effect re-ran, which is observable only through
  its side effects.
- **The effect cleanup disposes the controller** — toggle visibility and
  assert `dispose` was called.

`runtime.rs` contains two tests and both concern launch-command resolution.
Nothing in the repository exercises `handle_output`, `resize`, or `set_theme`.

### The cheapest thing on the board

One actor harness covers items 5, 6 and 7 above. It also covers area 01's
acceptance criterion 5, "PTY replies do not enter any client event stream" —
which is written directly into the region measured at zero coverage.

That criterion has **two producers, not one**:

```sh
rg -n 'write_response' core/backend/src/terminal/runtime.rs
```

Three hits: the definition, the call inside `handle_output`, and a third inside
`set_theme`, where `self.vt.set_theme(theme)` returns a response written to the
child. A theme change generates a PTY reply. A test that covers only
`handle_output` passes while half the requirement goes unchecked.

The `handle_output` half is confirmed without reading the body:

```sh
rg -n 'responses' core/backend/src/terminal/runtime.rs
```

Three hits, all inside `handle_output` — bound, tested, passed to
`write_response`. It never reaches `publish`. The strength is exhaustiveness: if
the identifier were published anywhere in the file, the command would show it.
The `set_theme` half has no equivalent check and holds by reading alone.

One harness, four claims, five paths.

**Two-thirds of the behaviour claims have nothing executing them.** Five of the
eight live in `TerminalView.tsx`, which has **no test coverage at all** — the one
apparent hit in the test directory is `defaultTerminalViewId` matching as a
substring. The single most-cited defect in the plan, `term.reset()` inside the
only production `installReplay` implementation, is in the least-tested file in
the capability. The controller's trace harness stops at the port boundary and
records `installReplay:<len>`; it never sees the reset.

## Retracted: the scroll-anchor hypothesis below is wrong

The section that follows claimed no saved viewport position exists anywhere. It
does. `terminalViewport.ts` exports `preserveTerminalViewport`, which captures
`baseY - viewportY` as a line offset and restores it after an update. I searched
`TerminalView.tsx` and `terminalScrollPin.ts` — two files I picked because I
expected the answer there. The helper is in a third, and
`ast-grep outline core/frontend/terminal --items exports --view names` lists it
in one command.

This is the `@xterm/[a-z-]+` defect one layer up: not a careless reading, a
search narrow enough that it could only confirm what I already believed.

**What is true instead**, by enumeration rather than reading:

```sh
rg -n 'preserveTerminalViewport|resyncTerminalViewport' core/frontend modules
```

Four call sites — `TerminalView.tsx:170`, `TerminalView.tsx:370`,
`terminalTheme.ts:92`, `terminalTheme.ts:130`. `installReplay` is not among them.
A theme change runs two paths at once: `applyThemeToTerminals` preserves the
viewport and skips hidden terminals, while `update_terminal_color_theme` fans out
through `TerminalService::set_color_theme` to **every** record, publishes a
replay, and `installReplay` resets the terminal with no preservation and no
hidden-terminal guard. A wrapper cannot fix it, because `term.reset()` zeroes
`baseY` before any restore could run.

The correct disposition is a constraint on the new path: `terminalBottomOffset`
is already the renderer-independent viewport quantity area 03 asks for, so the
extraction has an implementation to lift — provided it carries the
capture-before-reset ordering.

The original text is kept below so the retraction has a subject.

## The open question: where history loss actually comes from

The engine loses nothing — a replay re-encodes every retained row. So a real
user report of history loss on resize and theme change has its mechanism
downstream. The strongest candidate, and the evidence for it:

`installReplay` in `TerminalView.tsx` calls `unregisterTerminal`, then
`term.reset()`, then `term.resize(...)`, then re-registers. The only scroll
state that crosses that boundary is a boolean, `pinnedToBottomRef`. After
re-registration the sole scroll action is `term.scrollToBottom()`, and only when
that boolean is true.

A search of the view and `terminalScrollPin.ts` for any saved viewport
position — `scrollLines`, `viewportY`, `scrollToLine`, `buffer.ydisp`, or any
anchor — returns **nothing**. The state required to restore a position is not
stored anywhere, so it cannot be restored. A boolean cannot carry a location.

The consequence, if the reading is right: a user scrolled up into history who
changes the theme or resizes the window is returned to the bottom. The rows
survive; the user's place in them does not. That is what a user reports as
losing their history.

**This is a behaviour claim derived by reading, which is the method that failed
twice today. It is a hypothesis, not a finding.** It is stronger than the two
that were refuted, because it rests on an absence proved across the whole file
rather than on an inference from one function — but absence of a restore path is
not the same as observed loss.

What would settle it: scroll into retained history, record the viewport
position, trigger a theme change, and assert the position afterwards. The
retention arithmetic deserves the same treatment separately — the host default
budget is 16 MiB and its own test asserts that retains **at least** 10,000 rows,
while the renderer cap is exactly 10,000 rows and its own comment says it is
deliberately not derived from the byte budget. At the default the margin is zero
or negative, and the budget is user-raisable to 256 MiB while the row cap is
fixed.
