<!-- markdownlint-disable MD013 -->

# Step 10 — Delete the CLI's Rust policy twin and add the offline runtime

## Outcome

The online agent path already works and already delegates. The offline path is a
1 019-line Rust reimplementation of admission policy. This step replaces that
reimplementation with a headless TypeScript runtime, so the two paths share
semantics instead of resembling each other.

## What already exists — the draft mis-scoped this step

| Draft proposal | Reality |
| --- | --- |
| "Implement an authenticated online control bridge from CLI to ApplicationRuntime" | Built. `core/backend/src/instance/protocol.rs:24-30` — "the JSON-line envelope version for the authenticated local endpoint", `CONTROL_FRAME_SCHEMA_VERSION = 11`, with `ControlCaller` identity. `cli/src/instances.rs` (776 lines) is the client. |
| "Plugin-provided operations are namespaced by plugin id and discoverable through inspect output" | Built. `module_control::agent::CapabilityInvocation` (`agent.rs:47-56`) carries `capability_id`, `capability_version`, `provider_module_id`, `port_id`, and an **opaque** `response: Value` routed over the message bus. `shipctl capabilities` is the CLI surface. |
| "Keep the CLI lean and non-Tauri" | Enforced. `ops/check/bin/check-cli-boundary.mjs` / `just check cli-boundary` asserts no `tauri`/`wry` in the CLI's cargo dependency closure. |
| "Online/offline command split" | Built. `cli/src/args.rs:711-842` — `--offline` flags with `requires`/`conflicts_with` wiring across list, preflight, add, inspect, inspect-capability, diagnose, verify, set-enabled. |

So the semantic delegation mechanism is present and generic. The plan does not
need to design it. It needs to *use* it for workspace and configuration, and to
remove the one place that bypasses it.

## The one place that bypasses it

`cli/src/offline_modules.rs` (1 019 lines) reimplements module policy in Rust
for the offline path:

| Function | Duplicated policy |
| --- | --- |
| `list`, `inspect`, `inspect_capability` (`:284`, `:430`, `:451`) | artifact inventory and inspection shape |
| `preflight`, `pack`, `add` (`:306`, `:316`, `:322`) | admission and packaging |
| `set_enabled` (`:333`) + `no_op_operation` (`:406`) | enablement policy and synthesized operations |
| `diagnose`, `verify` (`:524`, `:580`) | diagnostic and verification semantics |
| `static_builtin_inspection` (`:483`) | **a static built-in inventory inside the CLI** — the same static membership that `ENABLED_MODULES = []` already removed from the frontend |
| `validate_schema_version`, `validate_diagnostics`, `require_matching_module` (`:236`, `:273`, `:259`) | contract validation rules |

`static_builtin_inspection` is the sharpest item: the CLI carries its own idea of
which modules are built in. That is a second composition root, in a third
language position, and it will drift from the artifact registry the moment a
built-in is added or removed.

This file is the counter-example named in Step 00's binding decisions. Replacing
it is the point of the step.

## Two paths, one semantic contract

| Path | Condition | Execution |
| --- | --- | --- |
| Online | an instance is discoverable on the authenticated local endpoint | existing control frames plus `CapabilityInvocation` into the accepted TypeScript runtime |
| Offline | no instance, or a deliberately validation-only operation | the CLI starts the headless TypeScript runtime with only the permitted ports |

Both use the same operation schemas, configuration semantics, manifest rules,
and response shape. The online path may report live session state; the offline
path must report a live-only capability as **unavailable**, never synthesize it.
`no_op_operation` (`offline_modules.rs:406`) is exactly the synthesis to avoid.

## CLI responsibility split

The Rust CLI keeps: command parsing, completion, help, version, packaging;
locating the endpoint and durable data root; framing, authentication, timeouts,
terminal-safe rendering; selecting online vs offline per the command's declared
capability; and JSON as the first output contract.

The TypeScript runtime owns: configuration parse/validate/migrate; artifact
discovery, admission, and graph construction; workspace inspect/validate/plan/
apply/reset; plugin operation providers; and semantic diagnostics.

The CLI must not reimplement workspace reducers, profile defaults, plugin
settings schemas, or Cordis resolution. After this step, `rg` for those concepts
in `cli/src` must return nothing.

## Avoid a protocol-version treadmill

`CONTROL_FRAME_SCHEMA_VERSION` is already at 11. If each new agent operation
becomes a new typed frame variant, every workspace or configuration operation
costs a Rust protocol release — which reproduces, at the transport layer, the
coupling this plan removes elsewhere.

Rule for this step: **new agent operations are delivered as capability
invocations with opaque payloads, not as new control frame variants.** A new
frame variant is justified only by a new transport concern (streaming,
cancellation, backpressure), never by a new product operation. Record the
justification when one is added.

## Headless runtime packaging — unresolved (Step 00, owner decision 3)

The offline runtime must be Tauri-free, versioned in lockstep with the plugin
ABI, discoverable by the installed CLI, able to load only admitted artifacts,
and testable without a graphical session.

Whether it is a bundled sidecar or a compiled executable is a packaging decision
with signing, notarization, and update consequences. It requires measured
startup time, installed size, macOS signing behavior, update mechanics, and
development ergonomics — and an owner. Do not silently depend on a
user-installed Node.js, and do not link Tauri into the CLI to run TypeScript.

One Homebrew formula can install the app, the CLI, and the headless runner
together. That is packaging, not a reason to grow the CLI.

Sequencing consequence: the **in-memory** headless bootstrap from Step 03 is
required and unblocked; the **packaged** headless runner is blocked on this
decision. Deliver online delegation and the Step 03 bootstrap first so the
offline packaging decision does not block the rest of the plan.

## Operation surface

Follow the existing CLI taxonomy (`cli/src/args.rs:37-91`: `Modules`,
`Capabilities`, `Messages`, `Schedule`, `Operations`, `State`, `Terminals`,
`Instances`). Workspace and configuration operations join it as namespaced
capability operations, discoverable through inspect output — not as arbitrary
subcommands injected into the root parser.

Inspect and validate ship before plan and apply. Apply is revision-aware and
emits a semantic plan before mutation. Online apply coordinates with the running
candidate graph; offline apply persists a transactionally valid document for the
next startup. Conflicts, denied grants, rejected artifacts, and unsupported live
state are structured outcomes, not text parsed from logs.

## Safety and authority

Headless execution receives only the ports its operation needs. It must not
start terminals, create desktop windows, or publish long-running effects merely
because a plugin is present. This requires a runtime operation mode that
validates and adapts contributions **without publishing interactive effects** —
a real capability gap in the current runtime, and a prerequisite for offline
apply.

## Refactoring actions

1. Define the operation request/response schemas in the public TypeScript
   contracts; generate or validate the CLI's expectations from them.
2. Deliver the online workspace/configuration operations over
   `CapabilityInvocation` first — no new frame variants.
3. Add the non-publishing runtime operation mode.
4. Stand up the headless runtime on the Step 03 in-memory bootstrap and prove
   parity against the online path with shared fixtures.
5. Resolve the packaging decision with measurements, then build the runner.
6. Replace `cli/src/offline_modules.rs` function by function, deleting each Rust
   implementation as its TypeScript equivalent passes parity.
7. Delete `static_builtin_inspection` and its static inventory outright — it has
   no TypeScript equivalent to build, because the artifact registry already is
   the inventory.
8. Keep rendering at the CLI edge; every command keeps a stable JSON response.

## Validation and exit criteria

- `just check cli-boundary` still passes; the installed CLI stays non-Tauri.
- `cli/src/offline_modules.rs` is deleted, or its remaining contents contain no
  admission, enablement, verification, or inventory policy.
- `rg "builtin|built_in"` over `cli/src` returns no static module inventory.
- The same fixture yields byte-equivalent semantic inspect/validate/plan output
  online and offline (proof obligation 6, Step 00).
- Offline validation opens no UI, starts no terminal, publishes no effect, and
  requires no system Node.js.
- A stale-revision apply fails safely and identically in both paths.
- A denied grant or missing capability is structured JSON with no fallback to a
  raw native invocation.
- `CONTROL_FRAME_SCHEMA_VERSION` did not increase for a product operation; any
  increase has a recorded transport justification.
- Package tests confirm the CLI, headless runner, and app are discoverable from
  their installed locations.
