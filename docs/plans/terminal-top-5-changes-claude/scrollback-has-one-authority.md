# Scrollback has one authority

## Context and purpose

Four components hold an opinion about terminal scrollback. None of them
agrees with another.

- **The user interface** offers 1k, 5k, 10k, 25k, and 50k
  (`core/frontend/shell/SettingsPanel.tsx:517`). Its tooltip says "Number of
  lines kept in the terminal scroll buffer."
- **The frontend store** defaults to 10,000
  (`core/frontend/terminal/useTerminalSettingsStore.ts:12`) and applies the
  value to xterm only, at construction (`TerminalView.tsx:88`) and on reveal
  (`:316`).
- **The backend** persists the same field with the same default
  (`core/backend/src/workspace/config.rs:143-149`, `:166-168`), but
  `normalize_terminal_settings` (`:195-197`) validates only the URL
  allowlist. Scrollback is never checked. Any `u32` from IPC or a hand-edited
  workspace file is accepted.
- **The host parser** ignores all of the above. `replay.rs:21` declares a
  private `MAX_SCROLLBACK_LINES: usize = 1_000` and passes it as
  `TerminalOptions.max_scrollback` (`:37`).

`TerminalLaunchRequest` (`terminal/types.rs:362-370`) carries the target,
cwd, environment, geometry, color theme, and metadata. It does not carry
scrollback. There is no path from the setting to the parser.

A unit hazard sits underneath. The pinned binding documents the field as a
line count — `libghostty-vt-sys/src/bindings.rs:2030` reads "Maximum number
of lines to keep in scrollback history" — and Ghostty's own C header says the
same. Ghostty's Zig source declares a byte budget. Three projects that embed
this library reached that conclusion independently: cmux fixed it (#2927),
openmux disabled the byte budget and enforced rows itself, and herdr renamed
its setting to `scrollback_limit_bytes`. If the unit is bytes, the host
retains about one kilobyte of history while the user believes they selected
50,000 lines.

Purpose: give scrollback one authority and one measured unit, so the
retention fix that both plans depend on has somewhere to land.

## Work to be done

1. **Measure the unit first.** Feed a known number of rows of known width to
   a `VtReplayEngine` built with a small `max_scrollback`. Count the rows the
   replay returns. Commit the measurement as a test so a dependency bump
   cannot silently invert it. Every later step depends on the answer.
2. **Validate in one place.** Extend `normalize_terminal_settings` to
   canonicalize scrollback against the supported values. The settings panel
   selects; it does not validate.
3. **Plumb the value.** Add scrollback to `TerminalLaunchRequest` and pass it
   from the spawn path to the runtime. Delete `MAX_SCROLLBACK_LINES`. The
   host must not hold a private opinion.
4. **State the live-change semantics.** `max_scrollback` is a construction
   argument. No setter exists at any layer, so a live change means rebuilding
   the VT state. Decide the behavior and write it down. The recommended
   default is that a change applies to terminals created after the save.
   Applying it to running terminals is separate work.
5. **Report retention honestly.** If the enforced budget is bytes and the
   product promise is rows, the descriptor must say when the host evicted
   rows. Do not let the renderer imply history that the host discarded.

Do not invent a number. Every constant this change introduces carries its
authority in a comment: the supported setting values, a platform limit, or
the committed measurement from step 1.

## Acceptance criteria

- A committed test states the unit of `max_scrollback` as a measurement, not
  as a citation of the binding documentation.
- `rg 'MAX_SCROLLBACK_LINES' core/backend/src` returns nothing.
- `TerminalLaunchRequest` carries scrollback, and a spawned terminal's VT
  state is built with the value derived from persisted settings.
- `normalize_terminal_settings` rejects or canonicalizes an out-of-range
  scrollback. A workspace file containing `"scrollback": 0` or
  `"scrollback": 4000000` loads to a supported value.
- A terminal that produced more history than one viewport, with the setting
  at 10,000, returns more than one viewport of history from a fresh host
  snapshot. Record the measured row count.
- The live-change semantics are documented in this file and match the code.
- The settings panel changes no validation logic.

## How to validate

```sh
just check all
just test rust
just test fast
```

Unit measurement, as a Rust test beside `VtReplayEngine`:

```text
build engine with a small max_scrollback
feed N rows of known width
snapshot
assert the returned row count against the measured relationship
```

Settings authority, as a Rust test in `workspace/config.rs`:

```text
deserialize a workspace file with an unsupported scrollback
normalize
assert the canonical value
```

End to end, by hand:

1. Set scrollback to 50k in the settings panel.
2. Run `seq 1 40000` in a terminal.
3. Detach and reattach the view.
4. Scroll back and confirm how far the history reaches. Record the number.

Repeat at 1k and confirm the retained history changes with the setting. If it
does not, the value is not reaching the parser.
