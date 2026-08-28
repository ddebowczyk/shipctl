# Terminal interaction review

This procedure records terminal behavior that depends on a packaged webview,
the platform keyboard and clipboard, or a real full-screen program. Automated
tests prove the semantic messages. This review proves that a person can use the
shipped surface.

This procedure is the manual proof cited by `selection.copy` and
`a11y.keyboard-focus` in
`modules/semantic-terminal/frontend/src/scenarios/capabilityRegister.ts`. It also supplies the
packaged checks for the optional unsafe-paste guard.

## When to run it

Run it before the area-05 cutover and after a change to terminal focus, paste,
selection, clipboard presentation, resize, or surface recovery. Run it for
each platform artifact that Shipctl ships.

## What to prepare

Use a packaged build. Record its build identifier, commit, target, app version,
terminal font, and terminal shell. Start with no `confirmUnsafePaste` entry in
`~/.shipctl/config.yml`.

Use a full-screen program that supports focus, mouse input, scrolling, and
resize in the tested shell. Record the program and version. The procedure does
not require one named program because Shipctl does not define one as a product
dependency.

## What to check

1. **Keyboard entry and escape.** Use only the keyboard to move focus into the
   terminal. Type text and confirm that it reaches the shell once. Use the
   normal application focus or navigation action to leave the terminal, then
   enter it again. Confirm that focus is visible and that application actions
   work when the input method does not own the key.
2. **Direct paste is the default.** Paste one safe single-line value and one
   multiline value. Confirm that each reaches the child once without a Shipctl
   confirmation. Repeat with `terminal.confirmUnsafePaste: false` explicitly
   set in `~/.shipctl/config.yml`.
3. **Unsafe-paste review is optional.** Set
   `terminal.confirmUnsafePaste: true`. Confirm that safe text still reaches the
   child once. Paste multiline or executable text, select Cancel, and confirm
   that no text reaches the child. Repeat, select Paste, and confirm that the
   exact original text reaches the child once.
4. **Selection and platform copy.** Print an unwrapped line and a logical line
   that wraps. Select each with the pointer, use the platform copy gesture, and
   paste into a plain-text editor. Confirm that the copied text matches the
   host selection and that a wrapped logical line is not given a false newline.
5. **Full-screen interaction.** Start the prepared full-screen program. Check
   focus entry and exit, resize the window, use its mouse interaction, scroll
   into history, and return to the live screen. Hide and show the terminal.
   Confirm that its screen, cursor, selection, and reading position stay
   coherent and that it remains usable.
6. **Renderer recreation.** Run the packaged
   `renderer.primary-failure` scenario while the terminal holds visible output
   and history. Confirm that the scenario passes without skipping. Continue
   typing and scrolling in the same terminal after recovery.

## What to record

For each numbered check, record pass or fail. For a failure, add the exact
action, visible result, and a screenshot or short recording. Record any
platform limitation that the product owner approves.

Store the dated result under `research/`. A completed record must identify the
platform artifact and the source commit. A procedure without an observation is
not proof.

## What a failure means

A duplicate or missing input, an unsafe paste sent after Cancel, copied text
that differs from the host selection, or a terminal that cannot regain focus
blocks cutover. Fix only the reproduced fault. Do not replace a platform
gesture with terminal-specific clipboard code unless the product contract
changes.
