<!-- markdownlint-disable MD013 -->

# Step 01 — Baseline and enforceable dependency wall

## Outcome

Create an explicit, checked inventory of where application policy crosses the
TypeScript/native boundary. The objective is not merely to remove import
statements. It is to distinguish a legitimate native capability from indirect
coupling where a feature still depends on Rust-owned policy through an
over-broad host service, static catalogue, or React shell.

## What the repository shows today

The starting point is healthier than the visual application shape suggests.
Production direct imports of Tauri packages are concentrated in
core/frontend/platform. Feature packages under modules currently do not import
Tauri directly. The significant coupling is indirect.

| Current location | Current responsibility | Why it blocks the target |
| --- | --- | --- |
| core/frontend/shell/AppShell.tsx | Instantiates native providers, module supervisor, workspace authority, canvas bridge, and contribution catalogue. | React is still the application composition root. |
| core/frontend/platform/tauri.ts | Broad facade for unrelated native commands and settings. | It can become a back door through the wall and obscures grants. |
| module-api/frontend/src/module/module.ts | One large ShipctlModule object combines commands, panels, menu surfaces, settings, terminal presentation, lifecycle, schedules, and messages. | It makes every module depend on a host-shaped bag rather than explicit services. |
| module-api/frontend/src/host/services.ts | ModuleHostServices is a broad capability bag. | Required authority is hard to see, test, or deny. |
| core/frontend/host/workspaceContributionCatalog.ts | Converts legacy panels and global surfaces to workspace definitions. | Workspace policy is owned by the host rather than its own application service. |
| core/frontend/workspace/authority.ts | Owns a useful semantic document reducer and validation. | It is in the right language but has the wrong lifecycle owner. |
| core/frontend/platform/workspacePersistence.ts | Maps workspace persistence directly to named Tauri commands. | Domain-specific persistence leaks native command vocabulary into TypeScript policy. |
| core/backend/src/workspace/config.rs | Owns canvas adapter and UI settings semantics. | Rust decides product configuration that extensions need to evolve. |
| core/backend/src/state/workspace_document.rs | Stores a workspace-shaped revisioned record. | Durable CAS is useful; workspace vocabulary should not be part of the generic kernel. |
| core/backend/src/state/workspace_layout.rs | Persists raw Layman snapshots. | Renderer implementation details risk becoming durable product state. |
| src/main.tsx | Obtains canvas adapter through native configuration. | Renderer selection is a TypeScript workspace/profile choice, not a native boot decision. |

The current Cordis integration, live module supervisor, accepted workspace
catalogue controller, artifact loader, and renderer-neutral workspace authority
are migration assets. This step must protect them from accidental replacement.

## Deliverable: a living dependency ledger

Add a source-controlled ledger when implementation begins. It should record,
for every existing native command and broad platform facade method:

- public semantic service or port that consumes it;
- exact native resource, operating-system authority, or durable primitive it
  owns;
- current callers;
- intended layer after the migration;
- whether the method is retained, split, renamed, deprecated, or deleted;
- an owner and deletion condition for its compatibility path.

The ledger should include all current platform adapters, including terminal,
assistant launch, project documents, credentials, plugin data, process, Git,
scheduler, usage, skills, project selection/events, notifications, and desktop
window actions. It is not a list of files to move mechanically; it is the
evidence needed to decide their boundaries.

## Enforce the wall before moving behavior

Introduce small static architecture tests. Existing tests already establish
parts of this direction; extend them rather than inventing a second mechanism.

| Rule | Enforcement intent |
| --- | --- |
| Only core/frontend/platform may import Tauri frontend packages. | AST or import-graph test over production TypeScript. |
| modules and module-api may not import core private paths, platform adapters, Tauri packages, Rust command strings, or host stores. | Static test with an allowlist for public module-api entrypoints. |
| core/frontend/runtime may not import React, Tauri, renderer code, or concrete feature modules. | Import-graph test. |
| canvas renderers may not call persistence or native ports. | Static test plus a renderer test double. |
| Only platform adapters may name native invoke command strings. | Search/AST assertion. |
| Public module-api contracts may not expose Cordis types or Tauri types. | Type-level API extraction check and import test. |

The rules need narrow, documented exceptions only during a migration step. An
exception must state which planned step removes it. A permanent exception is a
boundary decision and belongs in the ledger, not an unreviewed test allowlist.

## Refactoring actions

1. Produce the ledger from current platform adapters and Rust command handlers.
2. Map every AppShell construction responsibility to one of: native bootstrap,
   TypeScript application runtime, workspace plugin, renderer, or temporary
   compatibility adapter.
3. Trace all ModuleHostServices property reads and classify them into a
   semantic service, a presentation-only API, or an accidental host dependency.
4. Trace all workspace persistence calls and existing configuration readers.
5. Add the static rules with a deliberately small baseline; make new
   violations fail immediately.
6. Mark legacy entrypoints deprecated only after a replacement is available.

## Validation and exit criteria

- The ledger covers every direct native frontend adapter and every Tauri command
  exposed to the frontend.
- A developer can answer “what resource does this native operation own?” from
  the ledger without reading implementation code.
- CI fails if a plugin, module-api contract, runtime component, or renderer
  crosses the newly defined wall.
- No behavior changes are required in this step; existing terminal and module
  activation tests remain green.
- The next step can design explicit contracts using evidence rather than an
  assumed list of services.
