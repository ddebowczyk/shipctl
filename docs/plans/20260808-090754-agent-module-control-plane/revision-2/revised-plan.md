## BLUF

The target architecture is attainable through revised Phases 3–6, but the plan needs one important addition: it currently explains how agents manage modules, not fully how agents discover and operate the capabilities those modules expose.

The shortest path is:

1. Finish the message bus and scheduler foundations.
2. Define module packages, capability contracts and provider bindings.
3. Prove them with one live fixture module.
4. Add agent-facing capability discovery/invocation/watch APIs.
5. Extract terminal first, then assistants/sessions and project browser.
6. Migrate the remaining features.
7. Finish the developer loop and packaged verification.

## Current truth

- `shep-btu` is 8/14 complete; Phases 3–8 remain.
- `shep-gid` is 5/7 complete. Its two remaining tasks have now been correctly re-scoped to bus-only proofs.
- Scheduler is not built yet. It is 0/5; S1 is in progress.
- The scheduler checkout is currently incomplete: [mod.rs](/Users/ddebowczyk/projects/_ext_experiments/shep/core/backend/src/scheduler/mod.rs:9) references a missing `snapshot.rs`, and `cargo check -p shipctl-core` fails.
- Runtime module membership still comes from [enabledModules.ts](/Users/ddebowczyk/projects/_ext_experiments/shep/core/frontend/host/enabledModules.ts:14).
- The current [ShipctlModule](/Users/ddebowczyk/projects/_ext_experiments/shep/modules/api/frontend/src/module.ts:51) has contributions and messages, but no name or `defines`/`implements`/`requires` capability model.
- The current manifest schema has message declarations, but not runtime artifacts, assets or general capability-provider declarations.
- Several modules and project watching still import Tauri directly.
- The terminal port exposes lifecycle subscriptions, but not an attachable output stream. Rust still binds PTY output to a single `Channel<PtyOutput>` at spawn.

## Target model

Three separate concepts are needed:

| Concept | Responsibility |
|---|---|
| Capability contract | Defines a replaceable semantic API |
| Module artifact | Packages one implementation and its UI/assets |
| Provider binding | Connects an activated module instance to a capability contract |

A capability contract should contain:

- stable ID and version;
- request/query ports;
- emitted event types and observable topics;
- dedicated stream contracts;
- request, response and event schemas;
- provider cardinality: exclusive or multiple;
- supported scopes: instance, workspace or global;
- which surfaces agents may inspect, invoke or watch.

A module manifest should contain:

- module ID, human-readable name and version;
- runtime/API compatibility;
- bundled JavaScript, CSS and assets;
- `capabilities.defines`;
- `capabilities.implements`;
- `capabilities.requires`;
- UI contributions;
- requested grants;
- implementation-specific configuration;
- native-adapter requirements and restart classification.

A module should not have one mandatory “receive channel.” That would be too restrictive. A module can implement several capabilities with several endpoints:

- ports receive directed commands and queries;
- topics expose broadcast events;
- channels deliver directed asynchronous messages;
- streams carry continuous data such as terminal output.

The existing [message API](/Users/ddebowczyk/projects/_ext_experiments/shep/modules/api/frontend/src/messages.ts:31) already contains useful primitives for channels, topics and capability ports. It should become part of the general capability model rather than being replaced.

## Modules introducing new capabilities

Phase 3 currently calls for one authoritative capability catalog under `modules/api`. That should change.

`modules/api` should define the capability meta-contract and built-in host capabilities. Installed module artifacts may carry additional versioned capability definitions.

Preflight then:

1. Validates the capability definition against the meta-schema.
2. Registers it by ID, version and digest.
3. Rejects the same ID/version with incompatible content.
4. Validates provider and consumer bindings.
5. Makes the capability inspectable even if no provider is active.
6. Activates its ports/events only when a provider becomes active.

This lets a module introduce `acme.work-review`, for example, without modifying or rebuilding Rust.

## Packaging

Use npm/pnpm for source development, not runtime installation.

A source module can remain a normal workspace package built with Vite/Rollup. The runtime product should be an immutable Shipctl module archive containing:

```text
module.yaml
module.mjs
chunks/*
styles/*
assets/*
capabilities/*
messages/*
integrity.json
```

Host-owned peer dependencies should include React, React DOM and `@shipctl/module-api`, preserving the React singleton already proven by the loader.

`shipctl modules add` installs the validated archive by digest. It must not:

- run `npm install`;
- execute lifecycle scripts;
- create runtime `node_modules`;
- rebuild Rust;
- reload the webview.

An npm registry can later serve as an optional distribution mechanism, but the installed payload remains a Shipctl artifact.

## Missing agent-operability surface

This is the major addition required in Phases 3–5.

Agents need to operate capabilities, not merely enable their modules:

```text
shipctl capabilities list --instance <name>
shipctl capabilities inspect <capability-id> --instance <name>
shipctl capabilities providers <capability-id> --instance <name>
shipctl capabilities call <capability-id> <port-id> --input <json-or-file>
shipctl events watch <topic-id> --instance <name>
shipctl streams attach <stream-id> --instance <name>
```

These commands should use the existing same-user local instance protocol. No REST port is required.

Only explicitly agent-accessible ports/events/streams are exposed. This is not arbitrary message injection:

- Agents invoke declared, schema-validated capability ports.
- Agents observe declared events.
- Agents attach to authorized streams.
- Rust binds caller identity and grants at the control boundary.

## Revised remaining phases

### Phase 3 — packages and contracts

Extend [Phase 3](/Users/ddebowczyk/projects/_ext_experiments/shep/docs/plans/20260808-090754-agent-module-control-plane/03-artifacts-capabilities-and-preflight.md:1) with:

- deterministic module archive;
- module name and runtime assets;
- capability meta-schema;
- dynamic capability definitions;
- provider and consumer bindings;
- agent-accessible port/event/stream declarations;
- provider-selection rules;
- offline artifact and capability inspection.

Exit: a fixture archive defining a new capability can be added and inspected while disabled.

### Phase 4 — live provider runtime

Extend [Phase 4](/Users/ddebowczyk/projects/_ext_experiments/shep/docs/plans/20260808-090754-agent-module-control-plane/04-live-runtime-supervisor.md:1) so one atomic snapshot contains:

- active capability providers;
- message routes;
- UI contributions;
- schedule-addressable endpoints;
- resources and streams;
- provider health and activation identity.

Exit: fixture A becomes active; B replaces it atomically; invalid C leaves B active.

### Phase 5 — lifecycle and agent operation

Extend [Phase 5](/Users/ddebowczyk/projects/_ext_experiments/shep/docs/plans/20260808-090754-agent-module-control-plane/05-generic-lifecycle-and-reconfiguration.md:1) with:

- capability discovery;
- provider inspection and selection;
- typed port invocation;
- event watching;
- stream attachment;
- exact instance targeting;
- resource/stream leases.

Keep durable lifecycle operations and watchers, but do not persist bus events.

### Phase 6 — production capability extraction

Revise [Phase 6](/Users/ddebowczyk/projects/_ext_experiments/shep/docs/plans/20260808-090754-agent-module-control-plane/06-current-module-migration.md:1). Terminal and project browsing must now be included.

Recommended order:

1. Fixture: new capability, port, event, asset and schedule target.
2. Terminal: native resource adapter plus replaceable TypeScript implementation.
3. Assistants and agent sessions: consume terminal and expose session capabilities.
4. Project browser: projects, filesystem observation and left-navigation contribution.
5. TODOs and commands.
6. Git.
7. Utilization/usage and scheduled refresh.
8. Ports and skills.

## Terminal capability

Rust should retain the slowly changing PTY/process adapter. The terminal module owns semantic behavior and UI.

The capability should provide ports such as:

- list;
- spawn;
- inspect;
- write;
- resize;
- stop;
- attach/detach observer.

Lifecycle events such as started, renamed, exited and ownership changes go through the message bus.

PTY bytes should not go through the general bus. They need a dedicated host-owned, multi-subscriber stream with:

- session identity independent of the webview;
- ordered sequence numbers;
- read-only observers;
- bounded in-memory reconnect buffering;
- attach/reconnect after module or webview replacement;
- no routine disk persistence.

The UI, an assistant module and an external agent can then observe one terminal without competing for the original Tauri channel.

## Immediate execution path

1. Finish `shep-gid.4` and `.7` under their corrected bus-only scope and commit the message-bus foundation.
2. Finish scheduler S1, restore a green build, then execute S2–S4. S5 correctly waits for the live supervisor.
3. Prove a static fixture receives `shipctl schedule trigger` through the message bus without persistent writes.
4. Execute revised Phase 3 with one package/capability fixture.
5. Implement the minimum Phase 4/5 lifecycle and agent capability interface.
6. Run one decisive vertical proof:

```text
start named instance
add fixture archive
enable fixture
discover its new capability
call its port
watch its event
refresh and trigger its schedule
replace A with B
reject C while B remains active
disable and remove
verify no host rebuild, reload, or event persistence
```

That is the first point where Shipctl becomes meaningfully agent-operable. Terminal extraction should begin immediately afterward because it proves the hardest and most mission-critical combination: native resources, streams, module replacement and agent observation.

Tauri does provide events and Channels, but not the application-level schemas, grants, ownership, provider routing, reconciliation and diagnostics required here. Its event system is transport infrastructure; the Shipctl message bus supplies the domain semantics. [Tauri IPC guidance](https://v2.tauri.app/develop/calling-frontend/)

I made no Beads or documentation changes during this review.

<oai-mem-citation>
<citation_entries>
MEMORY.md:94-100|note=[Kept the path aligned with live reconciliation, immutable module URLs, and typed capability grants]
</citation_entries>
<rollout_ids>
019fdfe6-b57e-70b1-9702-4476414242bf
</rollout_ids>
</oai-mem-citation>
