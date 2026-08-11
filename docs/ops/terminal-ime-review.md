# Terminal IME review

A recorded human observation, for the same reason as
[the glyph review](terminal-glyph-review.md): the fact cannot be reached by a
self-driven scenario.

Synthetic `compositionstart` / `compositionupdate` / `compositionend` events
prove that the handler runs. They do not prove that a real input method behaves
the way the handler assumes. The candidate window, the commit timing, the
pre-edit underline, and what happens when composition is cancelled are all
properties of the platform's input method and the webview together — and both
differ per platform.

This procedure is the proof cited by `input.ime` in
`core/frontend/terminal/scenarios/capabilityRegister.ts`.

## When to run it

Before the area-05 cutover, and again after any change to input handling or to
how the surface receives keyboard events.

Run it on each platform the app ships to, with at least one input method that
composes.

## What to prepare

A packaged build. Enable a composing input method: Japanese (Romaji → Kana →
Kanji), Korean (Hangul), or Chinese (Pinyin) all exercise the full lifecycle.
A dead-key layout is not a substitute — it does not open a candidate window.

## What to check

Focus a terminal running an interactive shell, then:

1. **Pre-edit is visible.** Begin composing. The in-progress text appears at the
   cursor, and the shell has not yet received it.
2. **Pre-edit is not sent.** Nothing appears in the shell's line buffer while
   composition is open. Press Ctrl-C mid-composition and confirm the shell did
   not receive the pre-edit text.
3. **The candidate window is positioned at the cursor**, not at the corner of
   the window or the corner of the screen.
4. **Commit delivers once.** Select a candidate. The committed text reaches the
   shell exactly once — not once per keystroke, not duplicated alongside the
   pre-edit.
5. **Cancellation delivers nothing.** Begin composing, press Escape. Nothing
   reaches the shell, and the pre-edit is cleared from the display.
6. **Composition survives a repaint.** Begin composing, then trigger a theme
   change or a resize. The pre-edit is still there and still correct.
7. **Composition and application keybindings do not collide.** A keybinding that
   would otherwise fire (for example a tab switch) does not fire while a
   composition is open.
8. **Wide committed text occupies the right columns.** Committed CJK text
   occupies two columns per ideograph, and the cursor lands after it. This
   overlaps the glyph review deliberately: it is the case where an input bug and
   an occupancy bug look identical, so both procedures should agree.

## What to record

For each numbered check: pass or fail, with the platform, the input method, the
app version, and a screenshot or short screen recording for anything that is not
a plain pass.

File the result beside the run in `research/`, dated.

## What a failure means

Check 2 failing — pre-edit reaching the child — is a correctness failure, not a
cosmetic one: the shell receives characters the user never committed. It blocks
the cutover.

Checks 4 and 5 failing are the same class. Checks 1, 3 and 6 are presentation
faults, and an owner may accept one with a recorded decision; the register entry
then moves from `blocking` to `changed` and names them.
