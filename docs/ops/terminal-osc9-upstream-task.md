# Follow-up task: OSC 9 notification payload upstream

**Owner: Dariusz Debowczyk. Status: not started.**

This is the one piece of the single-VT closure that depends on a third party.
Start it early, because the merge is not ours to schedule.

Approved 2026-08-10: the payload goes upstream first, and a binding-only local
patch is carried only if the closure removes xterm before upstream merges. The
decision and its evidence are in [terminal-vt-dependency.md](terminal-vt-dependency.md),
gap 1.

## Why it is needed

The former xterm path was moved to
`modules/thin-terminal/frontend/src/ThinTerminalPresentation.tsx`; it does not
interpret OSC 9. The semantic-terminal module needs the parser to produce the
payload instead, and the pinned
`libghostty-vt` does not expose it.

Two clocks, and they do not start together. The payload is *needed* at closure
area 5. The filing must *start* now, because the review and merge latency
belongs to upstream. Nothing downstream is blocked meanwhile, and that is not a
reason to wait: a task started at area 5 arrives late by the length of someone
else's queue.

## Agents must not file this

Ghostty ships an agent guide (`AGENTS.md`, `CLAUDE.md`) that says: never create
an issue, never create a PR. Their contribution rules also need a human voice
and human understanding. So a coding agent may prepare and explain the patch,
but a human submits it.

## Upstream rules to follow

Read `CONTRIBUTING.md` and `AI_POLICY.md` in `ghostty-org/ghostty` first. The
rules that decide this task:

- **Vouch first.** Open a "Vouch Request" discussion. Write it yourself; the
  rules say not to have an AI write it. A maintainer replies `!vouch`. Pull
  requests from unvouched accounts are closed automatically. Check
  `.github/VOUCHED.td` for your account before assuming anything.
- **Discussion before pull request.** A pull request should implement an
  accepted issue. With no prior issue, open a "Feature Requests, Ideas"
  discussion and link a branch. Pull requests are not a place to discuss
  design.
- **Disclose the AI assistance.** Name the tool and state how much of the work
  it did.
- **Understand the code.** You must be able to explain the change, and its
  effect on the larger system, without an AI. Prepare for that before you
  submit.

`uzaaft/libghostty-rs` has no vouch system and no AI policy. It uses
conventional commit subjects such as `vt:`, `build:`, and `ci:`. A normal pull
request is acceptable there, but only after Ghostty merges, because its
bindings are generated from Ghostty's header at a pinned commit.

## The argument to make

Short, and strong enough to stand alone:

- `libghostty-vt` exists so embedders can build terminals.
- An embedder cannot show a desktop notification, because the payload never
  reaches it.
- Ghostty already parses the notification, already gives it a C layout, and
  already routes it to the handler.
- One dispatch arm discards it. The change is additive and breaks no ABI.

Search the issue tracker **and the discussions** before you file. `gh search`
does not cover discussions, so look manually.

## The change

Verified against Ghostty commit `ab0b9da9e88fcb4b0533a1854e84628f663930af`, the
commit `libghostty-vt-sys` pins today. Line numbers are from that commit.

What already exists:

- `src/terminal/stream.zig:372` — `ShowDesktopNotification` carries `title` and
  `body`, and already has a C layout through `cval()`:
  `extern struct { title: lib.String, body: lib.String }`.
- `src/terminal/stream.zig:2365` — the action already reaches the handler.
- `src/terminal/stream_terminal.zig:338` — the handler discards it.

`stream_terminal.zig:338` is the whole gap. The notification sits in an arm
labelled "Have no terminal-modifying effect", beside `progress_report` and
`title_push`. That is true of terminal *state* and wrong for an *embedder*.

The patch, in three files:

1. `src/terminal/stream_terminal.zig` — add an effect hook that carries the
   borrowed title and body, set it to `null` in `Effects.readonly`, and move
   `.show_desktop_notification` out of the discard arm into a dispatch arm.
2. `src/terminal/c/terminal.zig` — add the function pointer type, the `Effects`
   field, the trampoline, the entry in the trampoline table, and the arm in the
   callback setter enum. Follow `clipboard_write`: it is the existing
   payload-carrying, borrowed-memory precedent, at `:185`, `:391`, and `:442`.
3. `include/ghostty/vt/terminal.h` — add the typedef and the enum entry, before
   the `_MAX_VALUE` sentinel their enum rule requires. Document the borrow
   lifetime the way the neighboring callbacks do.

Tests belong beside the existing callback tests in `src/terminal/c/terminal.zig`
(see "set title_changed callback" at `:2755`). Run `zig build test-lib-vt`,
which their agent guide names as the right command for libghostty-vt changes.
Zig 0.16.x is required.

Leave out the OSC parser data kinds (`src/terminal/c/osc.zig` and
`include/ghostty/vt/osc.h`). They serve users of the standalone parser, Shipctl
does not need them, and they widen the pull request.

After Ghostty merges, `libghostty-rs` needs the pinned commit bumped, the
bindings regenerated, and a safe `Terminal::on_*` wrapper added. Today
`osc::CommandType::ShowDesktopNotification` carries no payload
(`crates/libghostty-vt/src/osc.rs:130`).

## Steps

1. Check whether your account is vouched.
2. Search issues and discussions for prior art.
3. Open the vouch request, in your own words.
4. Open the feature discussion, linked to a branch.
5. Build and test the branch, and make sure you can explain it unaided.
6. Open the Ghostty pull request once vouched and accepted, with the AI
   disclosure.
7. After the merge, bump the rev and open the `libghostty-rs` pull request.
8. Bump `modules/semantic-terminal/backend/Cargo.toml` and run the upgrade gate in
   [terminal-vt-dependency.md](terminal-vt-dependency.md).

## How this task ends

`the_desktop_notification_payload_is_not_exposed` in
`modules/semantic-terminal/backend/src/compat.rs` asserts the limit, so it fails as soon as
the payload becomes readable. That failure is the signal to delete the test,
delete gap 1 from the dependency page, delete this file, and remove any local
patch.

If upstream declines or stalls past closure area 4, apply the same diff as a
binding-only local patch and continue. That branch is approved and needs no new
decision.
