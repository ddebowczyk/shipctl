# The VT dependency is owned

## Context and purpose

`core/backend/Cargo.toml:23` pins the terminal parser to a third-party
repository at a single commit:

```toml
libghostty-vt = { git = "https://github.com/uzaaft/libghostty-rs",
  rev = "72ac98f292879bf9f788fcbb11238c562a1eebe6", default-features = false }
```

This crate is now load-bearing. It holds the canonical terminal state, the
replay that every recovery boundary depends on, and the retention budget the
product promises to users.

Two facts make the current arrangement unsafe for that role.

**The documentation is wrong on the field that matters most.**
`crates/libghostty-vt-sys/src/bindings.rs:2030` documents `max_scrollback` as
"Maximum number of lines to keep in scrollback history." Ghostty's own source
declares a byte budget. The binding mirrors an upstream C header that carries
the same error, so a reader who verifies the Rust wrapper against the C API
gets the same wrong answer twice. Shipctl's retention guarantee currently
rests on that sentence.

**No row-based trim exists.** Neither the Rust API nor Ghostty's C API
exposes a way to trim history by rows. Enforcing "50,000 lines" exactly
requires changing the dependency. openmux solved this by setting the byte
ceiling to `maxInt` and trimming by row in its own vendored Zig wrapper.

The build already clones Ghostty and runs Zig — `libghostty-vt-sys/build.rs`
does this today. Owning the dependency therefore adds no toolchain. It adds
ownership of a surface and a pin-update procedure.

Purpose: convert an unowned third-party commit into a surface Shipctl can
make a product promise on, before either plan builds a retention guarantee on
top of it.

## Work to be done

Four options are on the table. They are listed with their real costs.

- **A — tracked fork.** Fork `libghostty-rs` and Ghostty, add a row trim,
  rebase on upstream. Exact row enforcement. Two forks to maintain.
- **A′ — fork with a minimal patch.** The same ownership cost as A. The
  smaller patch does not remove the second fork.
- **B — no fork.** Keep the upstream pin, enforce the byte cap, and state
  weaker retention semantics honestly. No new ownership. The product promise
  becomes "about this much history", not a row count.
- **C — vendored release.** Vendor a released archive with in-tree bindings,
  as herdr does. Ownership of one in-tree surface, no rebase treadmill, and a
  place to carry a row trim later if needed.

**Recommended: C.** It costs less than A or A′, it removes the "someone
else's commit" risk that B leaves in place, and it does not close the door on
exact row enforcement.

The work under C:

1. Vendor the pinned upstream at a released tag under `vendor/`, with the
   provenance and licence recorded.
2. Move the bindings in-tree. Correct the `max_scrollback` documentation to
   the measured unit and cite the measurement from
   `scrollback-has-one-authority.md`.
3. Write the pin-update procedure: how to take a new upstream release, which
   tests gate it, and who approves.
4. Add a compatibility test that runs against the vendored build and fails on
   a behavior change in replay, resize, or retention.
5. Record in-tree the known upstream defects Shipctl relies on knowing: the
   `max_scrollback` unit, and the absence of a row trim.

If the owner selects B instead, the deliverable is the honest statement of
retention semantics plus the same compatibility test. Do not select B and
then describe retention as a row count.

## Acceptance criteria

- `core/backend/Cargo.toml` no longer references an external git revision for
  the VT parser, or a signed decision records why option B was chosen.
- The vendored source records its upstream version, commit, and licence.
- The in-tree `max_scrollback` documentation states the measured unit and
  cites the committed test that measured it.
- A pin-update procedure exists in this directory or in `docs/ops/`, naming
  the gating tests and the approver.
- A compatibility test fails if a future vendored version changes replay
  output, resize behavior, or retention for a fixed input.
- A clean checkout builds with no network fetch of the parser source.
- Build time before and after is recorded. A large regression is a finding,
  not an accepted cost.

## How to validate

```sh
cargo clean && just test rust
just check all
just test full
```

Reproducibility:

```sh
git clean -xdf target && cargo build --workspace   # no parser fetch
```

Compatibility, as a Rust test beside the replay engine: feed a fixture byte
stream, snapshot, and assert exact replay bytes. This test is the gate for
every future pin update.

Confirm the licence and provenance file is present and correct before the
change merges.
