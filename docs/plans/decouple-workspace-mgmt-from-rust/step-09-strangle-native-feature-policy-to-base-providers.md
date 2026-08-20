<!-- markdownlint-disable MD013 -->

# Step 09 — Remove the named vendors and the duplicated taxonomy from Rust

## Outcome

`core/backend/src` is ~61 000 lines. This step does not attempt to shrink that
number. It removes the specific places where Rust decides **product policy**,
identified by a single test: *does adding an ordinary product concept require a
Rust release?*

Three areas fail that test today, and they are the whole scope of this step.
Everything else in the audit table is retained on purpose.

## The three failures

### 1. The contribution-family taxonomy (blocks Steps 02, 07)

`core/backend/src/module_control/artifact.rs:509-525` defines
`RuntimeContributionFamily` — the same 15 members as
`PluginContributionFamily` (`module-api/frontend/src/module/plugins.ts:29-44`),
maintained by hand in a second language. Admission rejects an unrecognised
family with `ARTIFACT_CONTRIBUTION_INCOMPATIBLE`.

Consequence today: **adding a contribution family requires a Rust release.**
That conflicts with Step 00's non-recompiling feature-delivery invariant.

The decision is closed: **Rust keeps artifact integrity and registry authority;
the trusted TypeScript runtime owns plugin declaration semantics.** Native code
may reject a bad archive, digest/provenance failure, unsupported artifact
protocol version, or a request for an unknown native grant. It must not decide
which product contribution families, services, provider names, or workflows are
valid. The TypeScript runtime validates those declarations before activation and
publishes nothing on failure.

This does not mean that every product feature gets a bespoke new global family.
Ordinary plugins use the stable extension primitives: services, operations,
background effects, schedules, messages, configuration/state, workspace views,
and navigation/menu contributions. A truly new host primitive is a versioned
TypeScript plugin-contract evolution; it is not a reason to add an enum member,
ACL entry, or feature crate in Rust.

This preserves a useful native boundary without turning it into a product
release gate: Rust verifies the artifact can safely be admitted to the host;
the TypeScript runtime decides whether its declared graph is semantically
composable.

### Post-package deployment proof

This is not proven by converting nine repository modules or by an in-process
fixture. It exercises the production catalog/import route —
`getRuntimeModuleCatalog` → `loadRuntimeModules` → `moduleArtifactUrl` → the
digest-qualified `import(/* @vite-ignore */ url)` in
`core/frontend/host/{runtimeModuleLoader,moduleArtifactLoader}.ts` — with no
test `importModule` or URL-resolver override. The test must start from an
already-built host package:

1. package the app/CLI/headless runner and record hashes for the native binary
   and host frontend assets;
2. create and pack a fixture Cordis plugin **after** that package exists, outside
   the bundled-module source and seed path;
3. install and enable it only through the public artifact registry operation;
4. restart the unchanged host, then inspect the accepted artifact and exercise
   one declared operation, contribution, and plugin-data configuration write;
5. assert the recorded host hashes are unchanged and that no source build,
   rebundle, re-sign, or release step occurred between plugin packaging and
   activation.

The fixture uses only pre-existing ports/grants. A failure because it needs a
new privileged resource is a valid platform-boundary result; a failure due to
its module id, view identity, configuration key, provider name, or ordinary
declared contribution is a design failure.

### 2. Named vendors in `usage_sources`

`core/backend/src/usage_sources/mod.rs:38` hardcodes the provider set:

    ["claude", "codex", "antigravity", "gemini", "opencode", "pi"]

with a four-member `PROVIDER_QUOTA_SOURCES` array (`:40`), a per-vendor
`ProviderCacheData` enum (`:82-84`), per-vendor struct fields (`:130-132`), and
per-vendor `match` arms (`:139-151`, `:412-415`, `:457-459`).
`usage_sources/providers.rs` then implements each vendor by name —
`codex_provider_windows` reads `~/.codex/auth.json` and calls a vendor HTTP API
(`providers.rs:11-25`), and `claude`/`antigravity`/`gemini` follow at `:54`,
`:178`, `:706`.

Adding a usage provider today is a Rust change across six sites. This is
application policy: which vendors exist, where their credentials live, and how
their quota windows are parsed.

Target: a native `usage-source` port that executes a *described* collection —
read this permitted path, run this permitted command, perform this outbound
request under this grant — with the vendor list, parsing, and aggregation owned
by the `usage` plugin. Native code keeps only the permission boundary, because
"read an arbitrary path from the frontend" is exactly what the port exists to
prevent.

### 3. Named vendors in `assistant_launch`

`AssistantProvider::{Claude, Codex}` drives divergent native behavior:
Codex-specific pending-transcript capture (`assistant_launch/mod.rs:127-131`,
`215-216`, `240-242`, `285`, `332`, `337-394`) and Claude-specific
caller-assigned session ids (`:224-226`, `:262-265`).
`capture::{parse_claude_session_metadata, parse_codex_session_metadata}` (`:32`)
parses each vendor's transcript format in Rust.

Adding an assistant provider is a Rust change. Same disposition as usage: the
native side owns process launch, session lifetime, and permitted-path reads; the
plugin owns which providers exist, how their transcripts are interpreted, and
what capture strategy each needs.

The Codex capture strategy is genuinely delicate (a race against transcript
files). Moving it is the highest-risk item in this step and should be last,
behind measured evidence that a plugin-driven capture is not slower or racier.

## What is deliberately retained

| Area | Retained because | Not a candidate |
| --- | --- | --- |
| `semantic_terminal/` (7 675 lines) | binds `libghostty_vt`; a VT parser is a measured performance- and ABI-bound implementation. `projection.rs` explicitly copies every fact out before returning it. | the parser, the projection, replay, retention |
| `terminal_host/`, `processes/` | PTY and process lifetime | — |
| `scheduler/` (7 407) + `message_bus/` (4 825) | durable wake-up and delivery primitives that must survive a dead webview | the primitives; **not** feature-specific routes or schedules |
| `plugin_data/`, `project_documents/`, `state/archive.rs` | atomic writes, CAS, backup/recovery | — |
| `git/`, `skill_installation/`, `credentials/` | command execution, extraction safety, keychain | — |
| `instance/` (5 125) | the control plane Step 10 reuses | — |
| `module_control/` (12 195) | integrity, durable registry, artifact protocol compatibility, and native-grant vocabulary | product declaration semantics |

Do not "audit" these areas again in this step. They pass the test: adding an
ordinary product concept does not require touching them.

## Audit rule for anything not listed

For each native type, command, enum, config field, and event:

1. Which OS resource, protocol implementation, or durable primitive requires
   native ownership?
2. What is the stable TypeScript semantic port?
3. Is the remaining code a resource implementation, or a product decision?
4. If it is a decision, which plugin owns it after migration?

A proper-noun product name (`codex`, `claude`, `layman`, `legacy`) in native
code is a strong signal for question 3 and is worth grepping for directly.

## Structural rules that stay

`core/backend` stays Tauri-free. `core/tauri` translates commands, events,
lifetime, and state injection only. `src-tauri` remains the packaging shell
required by `tauri::generate_context!` and gains no behavior.

Do not create per-feature Rust crates mirroring the frontend module folders. A
native component is justified only by a shared privileged capability or a
measured performance-sensitive implementation.

## Strangler sequence per area

1. Add the TypeScript semantic service and its tests while the native policy
   still runs.
2. Route new paths through the service.
3. Import legacy native state once, idempotently (`migrateRecords`, Step 05).
4. Stop writing the legacy representation.
5. Watch migration diagnostics; keep an explicit recovery path.
6. Delete the Rust enum, command, state record, test fixture, and frontend
   adapter **together**, in one commit.

Step 6 is the step, not a follow-up. Each retained compatibility path needs a
`deletion_gates` entry naming its artifacts.

## Refactoring actions

1. Move contribution/service/role compatibility and graph-semantic validation
   into the trusted TypeScript runtime. Reduce `module_control` to integrity,
   durable registry, artifact-protocol compatibility, and stable native-grant
   vocabulary; remove `RuntimeContributionFamily` and all product-semantic
   admission branches.
2. Add the post-package deployment proof above before deleting the native
   taxonomy, so the proof exercises an independently packed artifact rather
   than a bundled module.
3. Replace the `usage_sources` vendor list with a described-collection port;
   move the four provider implementations into the `usage` plugin; delete the
   arrays, enum variants, struct fields, and match arms together.
4. Replace `AssistantProvider` divergence with a plugin-declared launch and
   capture description; move Codex capture last, with measured evidence.
5. Confirm `scheduler` and `message_bus` hold no feature-specific route or
   schedule after Step 08's conversions.
6. Group `core/tauri` command names by resource, not by feature screen.
7. Rewrite Rust integration tests to assert resource semantics, not TypeScript
   composition.

## Validation and exit criteria

- `rg -i "codex|claude|gemini|antigravity|opencode|layman|legacy"` over
  `core/backend/src` and `core/tauri/src` returns no product-policy match — only
  migration comments and deleted history.
- Adding a usage provider or an assistant provider requires no Rust change; a
  test adds a fixture provider from a plugin and it appears end to end.
- No Rust type, enum, validator, ACL, or match arm enumerates product
  contribution families or plugin-specific declaration semantics. The
  TypeScript runtime is the sole semantic declaration validator.
- The post-package deployment proof passes: an independently packed plugin is
  installed and enabled after the host package is built, then activates after
  restart with unchanged native and host-frontend hashes.
- Adding an ordinary plugin contribution, module identity, view, command,
  configuration key, usage provider, or assistant provider using existing
  contracts requires no Rust source change or Shipctl re-release.
- Each remaining native command maps to a documented resource-backed semantic
  port, and its name contains no feature-screen noun.
- Rust integration tests still prove terminal, process, credential, and
  filesystem correctness with no TypeScript fixture.
- `core/backend` still compiles with no Tauri dependency; `just check all` and
  `cargo test --workspace` pass.
- Every compatibility path retained by this step has a `deletion_gates` entry.
