<!-- markdownlint-disable MD013 -->

# Step 10 — Add headless runtime and agent CLI delegation

## Outcome

Give the lean Rust shipctl CLI access to the same TypeScript application
semantics as the running Tauri app. Agents can inspect, validate, plan, and
apply workspace and plugin configuration changes without making the CLI a
58 MB UI binary, without duplicating workspace rules in Rust, and without
requiring a React renderer.

## Two execution paths, one semantic contract

| Path | When used | Execution |
| --- | --- | --- |
| Online | Shipctl UI runtime is running and exposes its authenticated control endpoint | CLI sends a structured request to the accepted TypeScript ApplicationRuntime. |
| Offline | UI is not running, or an operation is deliberately validation-only | CLI starts or invokes a Tauri-free TypeScript headless runtime with only permitted ports. |

Both routes use the same public operation schemas, document/configuration
semantics, artifact manifest rules, and response format. The online route may
observe live session state; the offline route must clearly report unavailable
live-only capabilities instead of silently inventing results.

## CLI responsibility split

The Rust CLI remains responsible for:

- stable command parsing, shell completion, help, version and packaging;
- locating the configured runtime/control endpoint and durable data root;
- framing requests/responses, authentication, timeouts, and terminal-safe
  rendering;
- selecting online versus offline execution according to declared command
  capability;
- preserving machine-readable JSON as the first output contract.

The TypeScript runtime remains responsible for:

- configuration parse/validation/migration;
- plugin discovery/admission and service graph construction;
- workspace inspect/validate/plan/apply/reset;
- plugin/domain operation providers;
- semantic error and diagnostic records.

The CLI must not reimplement workspace reducers, profile defaults, plugin
settings schema, or Cordis dependency resolution in Rust.

## Headless runtime packaging decision

The offline runtime needs an intentionally packaged TypeScript executor. Do not
silently depend on a user-installed Node.js, and do not link Tauri into the
small CLI merely to run TypeScript. Evaluate packaging options using measured
startup time, installed size, macOS signing/notarization behavior, update
mechanics, and development ergonomics. The chosen solution may be a bundled
runtime sidecar or a compiled JavaScript/TypeScript executable, but it must be:

- Tauri-free;
- versioned in lockstep with the app/plugin ABI;
- discoverable by the installed CLI;
- able to load only admitted trusted artifacts; and
- testable without a graphical session.

One Homebrew formula can install both shipctl.app and the small shipctl command
plus its headless sidecar. This is a packaging concern, not a reason to make
the CLI contain the GUI executable.

## Initial operation surface

Prioritize agent-operable workspace and plugin operations:

    shipctl workspace inspect --json
    shipctl workspace validate --file <path> --json
    shipctl workspace plan --file <path> --expected-revision <n> --json
    shipctl workspace apply --plan <id> --expected-revision <n> --json
    shipctl workspace reset --profile <id> --json
    shipctl plugins inspect --json
    shipctl config inspect|validate|plan|apply --json

The final spelling can follow the existing CLI taxonomy, but the operation
contract must remain namespaced, structured, and generated or validated from
the TypeScript public schema. Plugin-provided operations are namespaced by
plugin id and are discoverable through inspect output; they are not arbitrary
subcommands injected into the root CLI parser.

## Safety and authority

Headless execution receives only the base ports needed for the requested
operation. It should not start terminals, create desktop windows, or activate
long-running effects simply because a plugin is present. The runtime needs an
operation mode that validates/adapts plugin contributions without publishing
interactive effects.

Apply is revision-aware and emits a semantic plan before mutation. Online apply
coordinates with the running runtime candidate graph; offline apply persists a
transactionally valid document for the next startup. Conflicts, unavailable
grants, rejected artifacts, and unsupported live state are structured outcomes,
not notices parsed from logs.

## Refactoring actions

1. Define runtime operation request/response schemas in the public TypeScript
   contracts.
2. Add a test-only in-memory headless bootstrap, then a packaged headless
   runner.
3. Implement an authenticated online control bridge from CLI to
   ApplicationRuntime; do not expose raw Tauri commands.
4. Add workspace/configuration inspect and validate first, then plan/apply.
5. Give each operation explicit port/grant requirements and headless effect
   policy.
6. Select and test the runtime-sidecar packaging approach before modifying the
   release formula.
7. Keep CLI rendering at the edge; ensure every command supports a stable JSON
   response suitable for agents.

## Validation and exit criteria

- The installed shipctl executable remains a lean non-Tauri CLI.
- Identical fixture documents yield equivalent semantic inspect/validate/plan
  output online and offline.
- Offline validation does not open a UI, create a terminal, or require system
  Node.js.
- A stale revision apply fails safely in both paths.
- A missing/denied capability is reported as structured JSON with no fallback
  to raw native invocation.
- Package tests confirm the CLI, headless sidecar, and UI are discoverable from
  their installed locations.
