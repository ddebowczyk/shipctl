# Phase 1 generic panel host gate

Date: 2026-08-06

## Result

The generic panel host is structurally and automatically verified. The built
macOS application launches alongside the user's existing Shep process under an
isolated bundle identifier. The interactive portion of the Phase 0 smoke
contract is not marked as passed because this execution environment lacks both
macOS Accessibility and Screen Recording permission.

Phase 1 changes no PTY ownership, project storage, panel behavior, shortcuts,
or global overlay placement. It replaces the four capability-specific render
branches with a registry lookup, lazy contribution load, and generic host.

## Final Phase 1 contract decisions

- Panel contributions use stable namespaced IDs and provide lazy component
  loaders plus host-facing metadata.
- `PanelRegistry` rejects malformed and duplicate IDs and returns a stable
  order.
- `PanelHost` owns loading, render isolation, retry, and safe tab removal.
- Terminal and assistant tabs remain PTY infrastructure, not panel
  contributions.
- Settings, Usage, and Ports remain global overlays; Diff Summary remains a
  layout slot. They are inventoried exceptions rather than hidden tab panels.
- Current built-in panels are wired through one transitional composition
  adapter. Feature imports do not occur in registry primitives.
- Unknown and disabled contribution IDs preserve their raw state and expose
  retry/remove recovery instead of crashing or silently disappearing.

## Dependency evidence

`src/core/modules/panels.ts` imports only a React component type.
`src/core/modules/panelRegistry.ts` imports only the panel contract. Neither
imports a feature component, store, or Tauri client. Capability imports are
contained in `builtinPanelRuntime.tsx`, the transitional composition adapter.

`AppShell.tsx` delegates an active local panel tab to one `PanelHost`; it no
longer contains separate Git, Commands, launcher, or TODO render branches. The
four built-ins are emitted as separate lazy production chunks.

## Persistence decision and deviation from the study

The study assumed a pre-existing persisted tab collection. The current Zustand
tab store is process-local and has no tab persistence middleware. Phase 1
therefore introduced and fixture-tested the versioned panel-reference codec,
but did not invent or activate workspace persistence inside this migration.

The live `UnifiedTab` model still carries the previous built-in kind values.
`panelPersistence.ts` and `builtinPanelAdapters.ts` translate those values at
the migration boundary. This is compatibility scaffolding, not the target
public vocabulary: the canonical constant is `BUILTIN_PANEL_IDS`.

Migration exit criterion: after stable panel-ID references are the sole live
read/write format and the old-shape compatibility window is intentionally
retired, remove `legacyKind`, the `source: "legacy"` marker, old-shape decoder
helpers and fixtures, adapter mappings, and legacy terminology from the live
panel architecture. Historical migration records may retain the term. This
criterion is also attached to the final host audit task `shep-3w1.8.7`.

## Verification evidence

| Check | Result |
| --- | --- |
| Panel tests | Pass: eight registry and persistence checks |
| Unknown ID | Pass: state retained; retry/remove available |
| Disabled ID | Pass: distinct from unknown; retry/remove available |
| Malformed data | Pass: isolated; original value retained |
| `pnpm build` | Pass: TypeScript and Vite production build |
| Isolated Tauri app build | Pass |
| Built-app launch | Pass: separate process and window observed |
| Registry primitive dependency inspection | Pass |
| `git diff --check` | Pass before this record; rerun at commit gate |

The build retained the baseline's non-blocking Node deprecation and Vite chunk
size warnings.

### Interactive smoke status

The isolated bundle used product name `Shep Phase 1 Smoke` and identifier
`com.shep.terminal.phase1smoke`. It ran beside the existing Shep process, so no
installed app was replaced and no existing PTY was targeted. Both builds read
`~/.shep/config.yml`; the smoke run therefore avoided persistent setting and
project mutations.

The runner could enumerate the isolated process and its window through
CoreGraphics. System Events returned `osascript is not allowed assistive
access (-25211)`, and screen capture was also denied. Consequently, no claim is
made that scripted clicks exercised the full Phase 0 manual checklist. The
interactive checklist remains the release/operator smoke contract; this is an
environmental evidence gap, not a known panel regression.

## Rollback and remaining adapters

- `85f8099` is the last checkpoint before AppShell renders through PanelHost.
- `d9214e8` adds the persistence/recovery compatibility seam.
- `6a1c219` activates registry-driven AppShell rendering.

Remaining transitional adapters:

- built-in tab kind to stable panel ID translation;
- old-shape persisted panel decoding;
- `BuiltinPanelRuntimeProvider` for Commands and launcher callbacks;
- built-in lazy loaders that import capability components from their current
  directories.

Phase 2 can package module rails without changing these adapters. Later
capability extraction removes each adapter only after its replacement passes
enabled, disabled, and source-absent checks.
