<!-- markdownlint-disable MD013 -->

# Step 06 — Make workspace management a Cordis service

## Outcome

Turn workspace management into a bundled TypeScript Cordis application plugin
that owns semantic workspace state, profiles, view-instance policy, layout
operations, persistence, recovery, and agent-facing operations. The renderer
continues to project that semantic state, but it is no longer its owner.

This is the central refactoring for a configurable Shipctl canvas. It enables
terminal, assistant, usage, projects, and future features to contribute views
without AppShell or Rust needing feature-specific placement logic.

## Reuse the existing semantic core

The current module-api workspace document and core/frontend/workspace authority
already contain the right conceptual starting point:

- UiWorkspaceDocument has workspace/profile identity, view instances, split and
  stack roots, floating state, and maximized stack state;
- WorkspaceAuthority validates, reduces, reconciles, and persists revisions;
- WorkspaceCanvasBridge creates renderer-neutral projections;
- workspace profiles currently provide a compatibility profile around the
  legacy canvas;
- the contribution catalogue converts legacy panels and global surfaces to
  workspace definitions.

Do not replace these with a Layman-owned model. Move their lifecycle and
catalogue ownership into the workspace plugin, evolve their public semantic
contract, and eventually delete the legacy conversion layer.

## Workspace plugin responsibilities

| Responsibility | Workspace plugin owns | Other plugins own |
| --- | --- | --- |
| View definition catalogue | validates stable ids, availability, singleton/multiplicity and capability requirements | declares view definitions and view bodies |
| Instances and layout | instance ids, split/stack/floating/maximized semantic document, focus and recovery policy | view-local state under its own namespace |
| Profile and frame preference | selected profile, semantic frame/navigation preferences, reset policy | optional profile and menu contributions |
| Commands and operations | inspect, validate, plan, apply, open/close/focus/move/split and future layout intents | requests to open/focus their declared views |
| Persistence | configuration document selection and revision-aware writes | their own configuration data |
| Rendering boundary | renderer-neutral projection and accepted catalogue snapshot | renderer implementation and view content |

The workspace plugin is a trusted bundled TypeScript plugin in the first
increment. That makes it upgradeable and inspectable through the same runtime
as other plugins while acknowledging that it has host-level responsibility.

## Evolve semantic operations before adding gestures

The present command surface supports opening, closing, focusing, selecting,
moving, splitting, and reset. The configurable-workspace target requires
additional semantic operations, designed and validated before a renderer emits
them:

- resize a split using normalized or bounded ratios;
- float a view with a semantic rectangle and monitor/viewport policy;
- dock a floating view into a target region;
- maximize and restore an instance or stack;
- create/remove named workspace profiles;
- change semantic frame and navigation preferences;
- recover unavailable, disabled, or replaced view definitions;
- reset one profile without deleting unrelated plugin state.

Every operation needs a precondition, deterministic result, revision behavior,
and a recovery policy. A move that would orphan an instance, create an invalid
tree, or target an unavailable view must fail without persisting a partial
document.

## Catalogue and unavailable-view handling

The workspace plugin consumes the accepted contribution catalogue from the
ApplicationRuntime, not speculative artifacts. When an accepted runtime graph
changes, it reconciles the workspace document:

- retain data for a temporarily unavailable view;
- render a recoverable unavailable-view placeholder with diagnostics;
- never silently repurpose an instance id to a different plugin;
- provide explicit replacement/remove/retry operations;
- maintain a valid focus target and layout tree.

This is particularly important when an extension is disabled, an artifact is
rejected, or a candidate activation rolls back.

## Agent-operable contract

Expose stable operations such as:

    workspace inspect
    workspace validate --document <path-or-id>
    workspace plan --input <document-or-patch> --expected-revision <n>
    workspace apply --plan <id> --expected-revision <n>
    workspace reset --profile <id>

The first delivery may require restart/reload after apply. Live application of
layout changes is optional; semantic inspection, validation, planning, and
revision-safe persistence are not optional.

Responses should include current revision, profile, view definitions, instances,
layout summary, unavailable contributions, diagnostics, and any activation
consequence. They must be machine-readable first, with human rendering at the
CLI edge.

## Refactoring actions

1. Package workspace authority, document validation, profile semantics, service,
   and canvas bridge behind a workspace plugin activation entrypoint.
2. Replace AppShell ownership with a workspace semantic service resolved from
   ApplicationRuntime.
3. Move compatibility profile selection into TypeScript configuration.
4. Replace the legacy contribution-catalogue adapter with direct view
   contributions as each module migrates.
5. Add semantic resize/float/dock/maximize/frame operations with property tests
   before implementing UI controls.
6. Add recoverable unavailable-view states and activation-revision
   reconciliation.
7. Provide inspect/validate/plan/apply operations through the runtime registry.
8. Retire workspace-specific native configuration and persistence commands
   after generic document ports are in use.

## Validation and exit criteria

- The workspace service can run in an in-memory headless runtime.
- No React component or Layman object mutates the canonical workspace document.
- A malformed or stale workspace apply leaves the durable document unchanged.
- Deactivation/rejection of a plugin leaves a valid workspace tree and a
  diagnosable unavailable view rather than a broken canvas.
- The compatibility legacy-canvas profile works as a migration bridge, but no
  longer requires Rust canvas selection.
- A fixture can create, inspect, validate, and reset a workspace using only the
  public TypeScript runtime API.
