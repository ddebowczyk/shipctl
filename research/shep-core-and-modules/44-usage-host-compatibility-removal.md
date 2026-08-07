# Usage host compatibility removal

Date: 2026-08-07

## Outcome

Usage no longer has a host compatibility implementation. The host composes the
frontend contribution and native plugin through generic contracts, while the
Usage module owns its settings schema, provider visibility, persistence,
ingestion, queries, UI, scheduling, styles, and resources.

The persisted surface ID remains `core.usage`, and the human-editable global
config key remains `usage`. Those are stable persisted identities rather than
host-owned types.

## Removed host ownership

The cutover removes:

- `src-tauri/src/usage.rs` and every flat Usage Tauri command;
- the typed `UsageSettings` and `ProviderBudgetConfig` host schema;
- Usage-specific load/save methods in workspace loader and manager code;
- the duplicate host-managed `UsageDb` state;
- host `rusqlite` ownership inherited only from Usage;
- the observed-model bridge from Usage; and
- the retired flat frontend model-catalog adapter.

`GlobalConfig` now deserializes the top-level `usage` value into its flattened
opaque capability map. Generic global-data reads and atomic replacements
preserve unknown top-level and provider fields.

## Module boundaries

The Usage frontend reads and replaces the `usage` document through
`ModuleGlobalDataPort`. It owns defaults and normalization and merges changed
provider settings into the last loaded raw document so unknown values survive.

The native Usage plugin receives a read-only `GlobalCapabilityDataAuthority`.
It asks for the opaque `usage` value and locally interprets only provider
visibility. Missing or invalid fields fall back to module-owned defaults.

All Usage native calls use `plugin:shep-usage|...`. The host knows neither
Usage command DTOs nor its provider settings schema.

## Model discovery belongs to Assistants

The model picker launches Assistant providers, so model discovery moved to the
Assistant native plugin instead of remaining attached to Usage pricing data.
The Assistant command is `plugin:shep-assistants|get_models_for_provider`.

- Claude combines stable aliases with account-specific values cached in
  `~/.claude.json`.
- Codex requests the signed-in account's current picker through `codex
  app-server` JSON-RPC and applies a bounded timeout.
- Pi, OpenCode, and Antigravity use provider-owned CLI catalogue probes.

Antigravity's catalogue command could not be exercised on this machine because
`agy` is not installed. The probe is isolated to the Assistant module and
returns an error rather than coupling model discovery back to Usage.

## Dependency proof

The host's only native Usage adapter implements the generic read-only global
data authority with `WorkspaceManager`. Core does not import Usage persistence,
provider DTOs, settings types, model logic, or commands outside composition.

Characterization tests assert that flat commands and typed host ownership do
not return. Module-boundary checks continue to forbid module internals from
leaking into core or sibling modules.

## Verification

The completed gate is expected to include:

```sh
pnpm test:usage-characterization
pnpm test:assistant-providers-characterization
pnpm test:module-boundaries
pnpm test:module-composition
pnpm build
cargo test -p shep --lib
cargo test -p tauri-plugin-shep-assistants
cargo test -p tauri-plugin-shep-usage
pnpm verify:usage-frontend-disabled
pnpm verify:usage-native-disabled
pnpm verify:assistants-frontend-disabled
pnpm verify:assistants-native-disabled
```

A production Tauri build in a dedicated target directory is the final runtime
composition proof. No running installed Shep application is replaced.
