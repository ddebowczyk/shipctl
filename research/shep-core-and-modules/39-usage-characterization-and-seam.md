# Usage characterization and seam

Date: 2026-08-07

## Outcome

Usage is now characterized before extraction. It is a global capability with
two related but distinct data paths: provider-reported quota windows and local
transcript-derived usage/cost reporting. It is not scoped to the selected
project, and switching projects does not reload or clear Usage state.

The safe target is a module that owns provider ingestion, normalization,
quota interpretation, SQLite queries, DTOs, state, panel/sidebar/settings UI,
styles, and provider branding. Core should retain generic application
scheduling, global settings-file persistence, generic global-surface hosting,
and generic sidebar/settings contribution placement.

Run the executable contract with:

```sh
pnpm test:usage-characterization
```

The fixtures are synthetic and contain no local paths, credentials, provider
tokens, transcript data, or account identifiers.

## Protected observable behavior

<!-- markdownlint-disable MD013 -->

| Behavior | Current contract |
| --- | --- |
| Provider order | Claude, Codex, Antigravity, Gemini, OpenCode, then Pi. |
| Primary quota | Prefer a `5h` summary window, then `7d`, then `30d`, then the first available window. |
| Sidebar windows | The compact widget switches only between `5h` and `7d`. It includes provider percentages only from provider-reported windows with a percentage. |
| Provider special cases | Antigravity shows its most-consumed matching quota. Gemini prefers `24h_pro`. |
| Visibility | `show: false` hides a provider. A shown provider with no activity still gets a zero cost/budget row; no shown rows hides the entire widget. |
| Custom budgets | A monthly budget is prorated into the current five-hour or Sunday-based seven-day block. The result is explicitly local and estimated. |
| Pace | Usage is compared with elapsed window time. A 20 percent band around the elapsed line is “on pace”; unavailable inputs produce no pace claim. |
| Tones | 50 percent is medium, 75 percent high, and 90 percent critical; unknown/local values use the local tone. An over-pace value can escalate earlier. |
| Reset display | ISO timestamps and epoch seconds are accepted. Invalid or missing values display `No reset`; elapsed resets clamp to zero. |
| Snapshot loading | A successful fetch atomically indexes snapshots by provider. A failed fetch clears loading and retains the existing snapshot map while exposing an error. |
| Settings save | Provider edits are optimistic. A failed persisted save restores the entire previous settings object and exposes an error. |
| Refresh cadence | Startup loads settings and snapshots, requests ingestion, re-fetches snapshots after three seconds, polls each minute, and reacts to `usage-ingest-complete`. |
| Project switching | Usage stores have no active-project key. Project selection closes the global surface but does not reset global snapshots, window selection, or settings. |
| Provider freshness | Successful provider quota calls cool down for five minutes. Failures back off from 30 seconds to five minutes. Only one provider refresh thread runs at once. |
| Provider failure | Cached provider windows remain usable after refresh failure. Without cache, local data can yield `partial`; absent local/provider data yields `unavailable`. Antigravity currently exposes its last provider error; other provider errors are logged and not surfaced in snapshots. |
| Local reporting | Startup and manual refresh ingest local CLI records into one Usage SQLite database. Queries produce 5h, 7d, 30d, and 365d totals, trends, models, projects, sessions, and resolved cost metadata. |
| Source explanation | The detail panel states that local totals and provider percentages measure different sources and can differ. |

<!-- markdownlint-enable MD013 -->

## Exact current ownership

Usage implementation that should move together:

- frontend DTOs in the Usage section of `src/lib/types.ts`;
- flat Tauri client calls in the Usage section of `src/lib/tauri.ts`;
- `src/stores/useUsageStore.ts` and `src/stores/useUsageSettingsStore.ts`;
- `src/components/usage/`, `src/components/sidebar/SidebarUsage.tsx`, and the
  Usage provider section inside `src/components/settings/SettingsPanel.tsx`;
- `src/lib/usageProviderLogos.ts` and the provider logo assets it imports;
- Usage-specific selectors in `src/styles/globals.css`;
- `src-tauri/src/usage/`, including SQLite schema/pricing, transcript cursors,
  provider adapters, normalization, caching, and reporting queries;
- Usage command wrappers and registrations in `src-tauri/src/commands.rs` and
  `src-tauri/src/lib.rs`.

Host responsibilities that remain generic:

- one application scheduler that can invoke module lifecycle work at startup,
  after a delay, and periodically;
- one global settings-file service that can load/save namespaced opaque module
  values without a typed `UsageSettings` host schema;
- global-surface registration, lazy loading, unavailable recovery, and footer
  navigation placement;
- sidebar layout and a generic sidebar contribution slot;
- Settings layout and a generic settings-section contribution slot;
- process shutdown and application lifecycle authority.

## Data sources and bounded assumptions

Provider quota adapters invoke local commands and HTTP endpoints rather than
provider SDKs. Codex reads the local Codex auth token and calls the ChatGPT
usage endpoint. Claude reads Claude Code credentials from the macOS Keychain.
Gemini reads Gemini CLI OAuth configuration and may refresh it. Antigravity
discovers its local language-server process, CSRF token, listening port, and
quota endpoint. Each command is timeout-bounded.

Local ingestion scans the CLIs' machine-local history/transcript locations for
Claude, Codex, Gemini, Antigravity, OpenCode, and Pi. Per-source cursors avoid
reprocessing unchanged input. SQLite owns normalization, project aliases,
pricing snapshots, local-cost estimation, and query aggregation.

These paths and undocumented provider endpoints are compatibility assumptions,
not host contracts. They must remain private to the module and fail as
unavailable/partial data rather than blocking app startup.

## Persisted settings caveat

Usage settings currently live as a typed `usage:` object in
`~/.shep/config.yml`. Existing camel-case keys `budgetMode` and
`monthlyBudget` must round-trip unchanged during extraction.

There is one existing default asymmetry to preserve until a deliberate product
change: the frontend fallback hides Gemini and Pi; a wholly absent native
`usage:` object hides Gemini but enables Pi, while a present object missing
only `pi` uses the hidden-Pi serde default. Characterization records this; the
modularization slice must not silently redefine it.

## Required host-contract evolution

The panel already fits the global-surface rail, but two visual placements are
still hard-coded:

1. add a generic ordered sidebar contribution slot so Usage can own the
   utilization widget without `Sidebar.tsx` importing it;
2. add a generic ordered settings-section contribution slot so the host
   Settings panel does not import Usage state, logos, DTOs, or provider logic;
3. add generic module scheduling hooks for startup, delayed follow-up,
   periodic work, and event-driven invalidation;
4. store Usage settings through a namespaced opaque global capability-data
   port, preserving human-editable YAML;
5. expose Usage native commands through an internal namespaced Tauri plugin
   whose state owns `UsageDb` and provider refresh state.

The module may directly own its bounded filesystem, process, Keychain, and
network adapters behind explicit native permissions. Core should not acquire
provider-specific credential or endpoint knowledge.

## Safe migration slices

1. Add and characterize generic sidebar, settings-section, scheduler, and
   global capability-data rails while current Usage callers remain adapters.
2. Create `modules/usage/frontend`; move DTOs, client, stores, helpers, panel,
   sidebar widget, settings section, styles, assets, and lifecycle wiring.
3. Create `modules/usage/backend`; move the database, ingestion, queries,
   provider adapters, caches, commands, and state into a namespaced plugin.
4. Remove typed host Usage config, flat commands, built-in Usage adapters, and
   hard-coded scheduling after all clients use module contracts.
5. Prove enabled, disabled, and physically source-absent builds. A persisted
   `core.usage` surface ID must degrade to generic unavailable recovery.

Because `src-tauri/src/usage/*.rs` and `src-tauri/src/commands.rs` contain
pre-existing uncommitted work, the next task must split these slices in Beads
and stage exact files/hunks only. No broad formatting pass is safe.

## Known limitations preserved, not expanded

- provider quota endpoints and local transcript formats can change outside
  Shep's control;
- local totals are machine-local observations, not account-wide billing data;
- provider quota percentages and local token/cost totals are intentionally not
  treated as equivalent;
- only Antigravity currently surfaces the provider-refresh error in its
  snapshot;
- the Usage panel has no explicit overview error state: a rejected overview
  request stops its spinner but leaves the prior value or loading placeholder;
- a project switch does not scope Usage to that project.
