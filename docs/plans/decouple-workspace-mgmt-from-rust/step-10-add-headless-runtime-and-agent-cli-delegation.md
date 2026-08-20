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
| "Online/offline command split" | Built. `cli/src/args.rs` preserves explicit `--offline` selection for generic artifact resources and capability invocation; the retired `modules verify` policy command is intentionally absent. |

So the semantic delegation mechanism is present and generic. The plan does not
need to design it. It needs to *use* it for workspace and configuration, and to
remove the one place that bypasses it.

## The retired bypass

Before the cutover, `cli/src/offline_modules.rs` (1 019 lines) reimplemented
module policy in Rust for the offline path:

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
The retired `no_op_operation` (`offline_modules.rs:406`) was exactly the
synthesis to avoid.

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

## Headless runtime packaging — bundled sidecar selected (Step 00, owner decision 3)

The offline runtime must be Tauri-free, versioned in lockstep with the plugin
ABI, discoverable by the installed CLI, able to load only admitted artifacts,
and testable without a graphical session.

On 2026-08-20, Dariusz Debowczyk selected a bundled Node runtime sidecar and a
bundled TypeScript program. The runner lives beside the packaged CLI, the
program lives in the application Resources directory, and the CLI invokes them
through a versioned local ABI. The runtime is signed as part of the application
bundle and updated with the same app/CLI/Homebrew package; it is never supplied
by the user. A future compiled runner may replace this implementation only if
it retains the executable location, request/response ABI, structured failure
codes, and one-package update behavior. It must not link Tauri into the CLI.

The package evidence records the actual installed size, cold-start measurement,
signature verification, Homebrew-style CLI discovery, and ABI-mismatch result.
Notarization remains a release-lane proof: it is performed by the existing
Developer-ID release command once the worktree is releasable, rather than being
claimed from an ad-hoc local build.

One Homebrew formula can install the app, the CLI, and the headless runner
together. That is packaging, not a reason to grow the CLI.

### Measured packaged evidence — 2026-08-20

Owner: Dariusz Debowczyk. The selected realm was measured in the actual local
macOS packaging path, not against a build-tree CLI:

```text
just build local
build: builds/b20260820T142614.275Z-g546bea581c1c-w36f4e2ece5c0-aarch64-apple-darwin
target: aarch64-apple-darwin
runtime: Node v24.15.0, copied into the app bundle
```

The signed preview app contained a 15,102,624-byte CLI, a
119,246,592-byte runtime sidecar, and a 2,325-byte bundled program; the full
app was 182,292 KiB and the DMG was 61,204,221 bytes. A fresh
`shipctl __headless-runner-probe` child process took `real 0.03` seconds and
reported a 46,252,032-byte maximum resident set size. This is a process-cold
measurement (no resident runner); macOS filesystem caches were not forcibly
evicted.

`codesign --verify --deep --strict --verbose=2` accepted the app, and the
package verifier passed both direct and Homebrew-style symlink discovery. With
`PATH=/usr/bin:/bin`, the installed CLI still located and invoked its bundled
runner, proving no user Node installation is consulted. A runner request with
`runnerAbi: 2` returned the structured
`headless.runner.abi_mismatch` response. The Tauri signer re-signs nested
executables without Node's JIT entitlement, so the CLI launches this narrow
headless process with `--jitless` instead of widening the app or CLI signing
surface.

This local build is ad-hoc signed and deliberately not notarized because the
Developer-ID credentials were absent; the existing release lane remains the
notarization proof. The one-package update contract is therefore: the app
bundle carries the CLI, runtime, and program together; a Homebrew package
updates that bundle atomically; and any future compiled replacement must retain
the same resource paths and runner ABI. A compiled alternative has no shipped
artifact or measured release path and is not selected.

Sequencing consequence: the **in-memory** headless bootstrap from Step 03 and
the packaged runner are both unblocked. Deliver online delegation and the Step
03 bootstrap first so the package boundary remains a narrow runner concern.

### Completion proof — 2026-08-20

The final local package build was
`b20260820T150248.617Z-g546bea581c1c-w44628a628066-aarch64-apple-darwin`
(`shipctl-preview` 0.8.2, arm64). Its app-bundle verifier passed the complete
bundle signature, direct and Homebrew-style-symlink CLI discovery, the bundled
runner ABI-v2 rejection, and preservation of the `runtime.invoke` failure
envelope when admission rejects a state root.

Using the app-bundled CLI and a fresh temporary state root, the package admitted
the generated `shipctl.runtime-operations` archive, enabled it through the
generic offline registry resource, and completed a real offline
`shipctl.workspace` `workspace.inspect` call with the
`capability.runtime.invoked` response. The admitted artifact digest was
`db4dc5bc04b1e3a88f6259efbd7b1c8f7fe5e66533d7a12f0adde693743b9b1c`.

`cli/src/offline_modules.rs` and its static-inventory test are deleted. Offline
artifact commands now call generic native resource operations; product semantic
capabilities invoke the packaged TypeScript runtime. `rg "builtin|built_in"
cli/src` is empty. The completion gates passed: `just check cli-boundary`,
`just check all`, `just test full`, and a separate `cargo test --workspace`.

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
