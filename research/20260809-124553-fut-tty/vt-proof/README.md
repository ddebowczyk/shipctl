# Host-canonical VT replay proof

## Decision

Use `libghostty-vt` as Shipctl's continuous host VT engine, pinned to commit
`72ac98f292879bf9f788fcbb11238c562a1eebe6` until an explicit compatibility
update reruns this proof.

The renderer contract is **host-canonical reset/resize/replay**, not independent
xterm reflow. An attachment applies the host replay and then ordered later
events. Every host geometry change is also an authoritative replay boundary.
This produces exact xterm-visible state across every fixture in this proof.

The stronger diagnostic comparison with an uninterrupted xterm stream passes
for ten of eleven fixtures. It intentionally differs after resize/reflow:
Ghostty and xterm represent the cursor at an exact wrap boundary differently.
That result rules out a protocol where xterm independently resizes and later
claims exact restoration. It does not invalidate the selected host-canonical
protocol: split replay plus later bytes equals a fresh replay of final host
state in all eleven fixtures.

## Reproduce

Requirements:

- the repository's Node dependencies, including `@xterm/xterm`;
- Rust/Cargo;
- Zig 0.16.x on `PATH` (the pinned `libghostty-vt-sys` build invokes Zig).

Run from the repository root:

```sh
./research/20260809-124553-fut-tty/vt-proof/run.sh
```

The independent Cargo workspace writes its intermediate fixture stream under
`target/vt-replay-proof/`, then prints the comparison as JSON. It does not
modify the application workspace dependency graph.

## What is compared

For every fixture, the Rust adapter:

1. initializes a bounded Ghostty terminal;
2. feeds the prefix and captures xterm-compatible replay;
3. feeds the suffix and captures final host replay;
4. records terminal-generated query responses.

The Node comparison then builds three xterm states:

- uninterrupted input (a diagnostic reference);
- split host replay followed by the suffix;
- fresh final host replay (the authoritative gate).

It compares dimensions, active screen, visible cells and attributes, wrapped
rows, cursor, and modes that affect subsequent input. For query fixtures it
also proves that both parsers emit a response. For OSC 8 it proves that the
replay retains the URI.

The acceptance gate is exact equality between split replay plus suffix and
fresh final host replay. That is the production attachment protocol. The
uninterrupted comparison remains in the report so a future dependency update
cannot hide a semantic change.

## Results on the supported build platform

Measured on 2026-08-09 on arm64 macOS, the platform exercised by Shipctl's
`macos-15` CI and `aarch64-apple-darwin` release scripts:

| Fixture | Split/final host match | Uninterrupted diagnostic | Replay bytes |
| --- | --- | --- | ---: |
| ordinary text | pass | pass | 5,569 |
| soft wrapping | pass | pass | 5,571 |
| cursor and erase | pass | pass | 5,577 |
| colors and styles | pass | pass | 5,756 |
| OSC 8 hyperlink | pass | pass | 5,916 |
| alternate screen roundtrip | pass | pass | 11,169 |
| synchronized output | pass | pass | 5,579 |
| Unicode/graphemes | pass | pass | 5,597 |
| resize and reflow | pass | differs as documented | 5,611 |
| terminal modes | pass | pass | 5,601 |
| query response | pass | pass | 5,565 |

The largest measured replay is the dual-screen alternate-screen fixture at
11,169 bytes. This is evidence, not a queue limit: production queue and frame
capacity must be derived from actual supported terminal dimensions and
transport framing rather than this small fixture.

## Adapter requirements discovered by the proof

The library formatter is a foundation, not the complete Shipctl replay
adapter. The checked-in spike documents the compatibility layer that must move
into core with its tests:

- serialize both primary and alternate screens and restore the active one;
- use formatter unwrapping and restore cursor state after cell replay;
- preserve OSC 8 metadata for historical cells;
- preserve a pending wrap cursor cell (the same edge case handled by cmux);
- synthesize a blank wrapped continuation that Ghostty retains after reflow;
- normalize xterm's default styled space to a visually empty cell;
- surface parser-generated query responses to the PTY writer;
- reject dimensions whose checked cell budget overflows.

Shipctl must create xterm with `reflowCursorLine: true`. More importantly, the
host and renderer must never resize independently: a successful host resize
returns/publishes a complete reset/resize/replay boundary before input resumes.

## Dependency and build impact

- Dependency: `libghostty-vt` / `libghostty-vt-sys` 0.2.1 from the pinned Git
  commit above, matching Fut's current pin.
- License: `MIT OR Apache-2.0` in the pinned crate manifest.
- Build tool: Zig 0.16.x is a required build prerequisite.
- Clean standalone release build on the measured machine: 47.60 seconds wall
  time.
- Standalone release proof executable: 1,720 KiB on disk, arm64 Mach-O.
- Standalone release Cargo tree: 758,752 KiB on disk.

The standalone executable is not an application size delta; it includes its
own Rust entrypoint and runtime. Measure the actual Shipctl bundle delta after
the adapter is linked into `shipctl-core`. The source/build-tree cost and Zig
prerequisite are real and must be added to CI/release setup in the same change
that adds the production dependency.

## Update rule

Do not float the Git dependency. To update it:

1. change the exact revision in the spike and application together;
2. rerun all fixtures on every supported Shipctl build target;
3. inspect both canonical and uninterrupted diagnostics;
4. remeasure clean build and bundle impact;
5. record any adapter workaround removed or added by the new revision.

If the canonical comparison fails, the update does not ship. If a new xterm
version changes resize semantics, retain the host-canonical protocol and
either adapt replay explicitly or choose a versioned snapshot renderer
protocol; never substitute a raw output tail for exact state.
