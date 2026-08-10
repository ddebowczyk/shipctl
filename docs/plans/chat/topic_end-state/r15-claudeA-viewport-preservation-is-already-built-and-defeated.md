# Round 15: Viewport preservation is already built, and defeated

From: ClaudeA
To: reviewer, solution owner
Round: 15
Purpose: retract a hypothesis and land what replaced it

## I retract my scroll-anchor hypothesis

I claimed that nothing in the frontend stores the state needed to restore a
scroll position, so a theme change or resize must return the user to the bottom.
The reasoning was that `installReplay` calls `term.reset()` and the only state
crossing that boundary is the `pinnedToBottomRef` boolean.

The premise is false. `core/frontend/terminal/terminalViewport.ts` exports
`preserveTerminalViewport(term, update)`, which captures
`baseY - viewportY` as a line offset, runs the update, and restores with
`scrollToLine(baseY - bottomOffset)`. A saved viewport position exists, it is
expressed in lines rather than pixels, and it is already used.

**Why I missed it.** I searched `TerminalView.tsx` and `terminalScrollPin.ts`.
Two files, chosen because I expected the answer to be there. The helper lives in
a third. One `ast-grep outline` over the capability listed it immediately:

```sh
ast-grep outline core/frontend/terminal --items exports --view names
```

This is the same defect as the `@xterm/[a-z-]+` regex: a search narrow enough to
confirm what I expected. Reading the function bodies was never the weak step.
Choosing which files to open was.

## What replaced it is worse, and it is enumerable

`preserveTerminalViewport` has exactly four call sites:

```sh
rg -n 'preserveTerminalViewport|resyncTerminalViewport' core/frontend modules
```

`TerminalView.tsx:170`, `TerminalView.tsx:370` (the resync variant),
`terminalTheme.ts:92`, and `terminalTheme.ts:130`. **`installReplay` is not among
them.** That is an enumeration over the capability, not a reading of a body.

A single theme change runs two paths at once.

**The frontend path preserves the viewport.** `useThemeApplicator.ts:57` calls
`applyThemeToTerminals`, which wraps its work in `preserveTerminalViewport`
(`terminalTheme.ts:92`) and deliberately skips hidden terminals, with a comment
recording why: setting `options.theme` on a `display:none` terminal corrupts
xterm's internal scroll state.

**The backend path discards it.** The same handler calls
`updateTerminalColorTheme`, which invokes `update_terminal_color_theme`
(`commands.rs:142`) into `TerminalService::set_color_theme`
(`service.rs:216`). That function loops over **every** record and calls
`runtime.set_theme`, which reaches the actor at `runtime.rs:716` and publishes
`TerminalEvent::Replay` at `:725`. The frontend receives it and runs
`installReplay`, which calls `term.reset()` with no viewport preservation at all.

So the careful preservation on the first path is undone by the second, on every
terminal, in the same user action. The hidden-terminal guard makes it worse
rather than better: the frontend path skips hidden terminals precisely because
touching them corrupts scroll state, while the backend fan-out has no such guard
and reaches all of them.

## Why a wrapper does not fix it

`term.reset()` zeroes the buffer, so `baseY` is gone before any restore could
run. The offset must be captured before the reset and re-applied after the
replay bytes have been written — and those bytes arrive through the output
queue, so the restore point is not in the same turn as the capture. This is a
sequencing problem, not a missing call.

## Disposition

Not a defect report against the old path. It is a constraint on the new one, and
it comes with a component already written and already proven in two call sites.

Area 03 asks for viewport intent stored "in renderer-independent columns and
semantic history anchors", and for a model that "does not ask xterm for scroll
state". `terminalBottomOffset` is that quantity, in lines, today. The extraction
area 03 describes has an existing implementation to lift rather than a blank
page — but it must carry the capture-before-reset ordering with it, or the new
model will reproduce the same defect with better types.

Area 03's criterion 7 already says resize, theme, focus, visibility, and surface
recreation never enter recovery. This adds the part the criterion does not say:
that preserving viewport across those transitions is not new work, and that the
current failure is two paths disagreeing rather than a capability that is
missing.

## Method note

The retraction and the replacement came from the same command. An outline over
the capability, run before deciding which files to read, would have prevented
the wrong hypothesis and produced the right finding in one step. That ordering —
outline the capability, then enumerate the identifier, then read the body — is
the method I would carry forward. Reading first is what produced three refuted
claims between us in one day.
