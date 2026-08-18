<!-- markdownlint-disable MD013 -->

# Step 03 — Extract the TypeScript application runtime

## Outcome

Make a renderer-independent TypeScript ApplicationRuntime the sole application
composition root. It owns the Cordis graph, plugin admission, configuration
projection, accepted contribution catalogue, lifecycle, diagnostics, and
semantic operations. AppShell becomes a thin React bootstrap and renderer
consumer rather than a place that creates business services.

## Why this comes before workspace UI work

Today AppShell constructs semantic service registries, core activation, native
providers, LiveModuleSupervisor, workspace authority, workspace canvas bridge,
and the contribution catalogue. Moving workspace code alone would merely move a
new dependency into the same React composition root. The runtime must be
extractable before plugins can be truly self-sufficient.

The existing staticPluginRuntime adapter, LiveModuleSupervisor,
runtimeModuleLoader, moduleArtifactLoader, and accepted workspace catalogue
controller should be composed into the new runtime incrementally. They are not
throwaway prototypes.

## Runtime responsibility

ApplicationRuntime should accept injected ports and expose a semantic snapshot
and operation surface. It should not import React, a canvas renderer, or Tauri.

| Input | Examples |
| --- | --- |
| Native base-service ports | terminal host, process control, credentials, filesystem-backed documents, desktop bridge |
| Artifact source | bundled artifact directory, installed artifact registry, integrity/admission provider |
| Configuration/document port | generic revisioned durable document capability |
| Runtime policy | trusted artifact policy, feature flags, bootstrap compatibility profile |
| Diagnostics sink | structured events, health snapshot, notices adapter |

| Output | Consumers |
| --- | --- |
| Accepted runtime snapshot | React shell, CLI bridge, diagnostics |
| Semantic service resolver | accepted plugins and privileged host adapters |
| Contribution catalogue | workspace plugin and renderer |
| Operation registry | UI command surfaces, online CLI, headless CLI |
| Lifecycle controls | native bootstrap and orderly shutdown |
| Structured diagnostics | logs, inspection commands, user notices |

## Lifecycle model

The runtime should follow an explicit candidate-to-published sequence:

1. discover manifests and configuration;
2. resolve artifact graph, service dependencies, and grants;
3. instantiate a candidate Cordis graph;
4. validate manifests, settings, contribution identities, routes, schedules,
   and required capabilities;
5. activate candidate plugins into staged registries;
6. atomically publish the accepted snapshot and start owned effects;
7. dispose the previous graph only after publication is safe;
8. emit a structured revisioned outcome for inspection.

Failure before publication disposes staged effects and leaves the prior accepted
graph intact. This is essential for the reported class of “runtime revision was
rejected” failures: the agent must be able to inspect why, and the UI must not
be left partly rewired.

## Bootstrap variants

The same constructor should support three compositions:

| Composition | Supplied ports | Purpose |
| --- | --- | --- |
| Tauri UI runtime | full native ports plus React renderer adapter | normal desktop application |
| Headless runtime | durable config/documents and explicitly allowed non-UI ports | offline CLI inspection, validation, planning, and apply |
| Test runtime | deterministic fake ports and fixture artifacts | contract, property, and failure tests |

This does not mean the UI and CLI are the same process. It means their
application semantics come from the same TypeScript implementation.

## Refactoring actions

1. Define the renderer-independent ApplicationRuntime facade under
   core/frontend/runtime or a renamed trusted TypeScript host package.
2. Move the non-React construction currently in AppShell behind that facade.
3. Make native/Tauri bootstrap create platform adapters and inject them; it
   must not select application features or construct workspace policy.
4. Have AppShell subscribe to runtime snapshots and render a selected canvas
   adapter only.
5. Move startup notices and diagnostics to a structured runtime event stream;
   React maps appropriate events to pushNotice.
6. Keep existing supervisor and static adapter behind the facade while later
   steps replace their legacy inputs.
7. Add an in-memory test bootstrap before adding a headless executable.

## Validation and exit criteria

- A test activates the same fixture plugin graph with no DOM and no Tauri
  package imported.
- AppShell no longer constructs workspace authority, module supervisors, or
  semantic registries itself.
- Native bootstrap code is limited to platform port creation, configuration
  location, lifecycle wiring, and renderer launch.
- A failed candidate graph leaves the preceding runtime revision, contribution
  catalogue, and active effects unchanged.
- Runtime diagnostics identify plugin, manifest version, grant, phase, and
  causal error without relying on a transient notification.
- Existing application startup and shutdown behavior remains covered while the
  legacy module adapter is still in place.
