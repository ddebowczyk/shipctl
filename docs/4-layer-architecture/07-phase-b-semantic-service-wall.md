# Phase B: semantic service wall

<!-- markdownlint-disable MD013 -->

## Outcome

All feature modules use public semantic services. Only trusted platform code
imports Tauri frontend APIs. Existing Rust commands and feature behavior remain
in place behind the adapters.

This is the first runtime change and the strongest no-regret slice. It makes
headless plugin behavior testable without a DOM and presentation behavior
browser-testable before Cordis or dynamic artifact loading is introduced.

## Implemented foundation

The shared foundation is present before the first capability migration:

- `module-api/frontend/src/protocol/semanticServices.ts` defines versioned
  service references, activation identities, requests, events, ordered
  streams, cancellation, errors, correlation IDs, leases, and disposal;
- `module-api/frontend/src/testing/` supplies a DOM-free and Tauri-free test
  host and deterministic service controls;
- `core/frontend/runtime/` binds providers to one activation and disposes
  activation-owned effects in reverse registration order;
- `core/frontend/platform/semanticServiceAdapter.ts` binds a typed request to
  an activation before private transport dispatch. It exposes no operation
  string or generic invoke method;
- the module message bridge and service registry use the same logical
  activation ID;
- `ops/modularity/legacy-tauri-imports.json` records every current direct Tauri
  import outside `core/frontend/platform`. The boundary checker accepts only
  those exact existing edges and rejects additions or stale ledger entries.

This foundation does not satisfy the Phase B exit. The ledger currently holds
17 imports. Each capability task must add its semantic adapter and conformance
proof, migrate consumers, then remove its import and ledger entry. The ledger
is a deletion queue, not an approved target boundary.

## Implemented capability slice: Processes for Ports

The Ports frontend now uses `shipctl.processes@1` through its exact module
activation. The public API exposes process inspection, termination by opaque
inspection identity, and command availability. The trusted platform adapter is
the only code in this slice that knows the legacy Tauri commands, PID argument,
or snake-case response fields.

A successful rescan invalidates earlier frontend inspection identities. A
successful termination invalidates every identity for that PID. Generated
properties cover result mapping, numeric and string boundaries, stable errors,
denial, cancellation before dispatch, stale and unknown identities, dispatch
count, correlation, activation attribution, and the Tauri-free fake provider.

This is not the final native process authority. The current Rust command still
terminates by PID. Phase D must identify and verify a stable OS process identity
at the native boundary before it can close PID-reuse risk.

## Implemented capability slice: Project Documents for Todos

The Todos frontend now uses `shipctl.project-documents@1` through its exact
module activation. The public API exposes bounded document discovery,
project-relative text reads, content revisions, and compare-and-write. The
trusted frontend adapter is the only frontend code in this slice that knows
the private request envelope. Phase B first delegated to transitional Todos
command names; Phase D replaced them with the permanent private Project
Documents adapter. Todo parsing and mutation policy lives in TypeScript.

The native adapter authorizes registered projects, rejects non-normalized and
escaping paths, rejects symbolic-link documents, bounds discovery with the
existing Todo limits, and publishes complete UTF-8 content with a same-directory
atomic rename. Stale and create-versus-replace revisions fail with a stable
conflict error. The app-local write lock makes operations from this process
serial. It cannot make compare-and-write linearizable against an unrelated
external editor; atomic publication and stale-at-check rejection are the
characterized guarantees.

The current host `ProjectRef.id` is still path-backed. The service does not
return absolute paths, but Phase E admission must introduce an opaque native project
identity before this capability is granted to third-party artifacts.

## Implemented capability slice: Git

The Git frontend now uses `shipctl.git@1` through the exact activation supplied
to panels, project layout, project actions, lifecycle hooks, and related-project
discovery. The public API uses semantic requests and a scoped repository-change
event. Only the trusted platform adapter knows Tauri command names, snake-case
native values, and the `git-fs-changed` event.

The module package has no Tauri dependency or native event listener. Its
in-memory provider runs file browsing, worktree creation, status refresh, and
repository observation without Tauri. Generated properties cover DTO and
stable-error mapping, input validation, cancellation before dispatch, exact
activation and correlation attribution, scope filtering, event order, and
lease disposal. Phase D has now replaced the transitional plugin commands with
the permanent Tauri-free Git provider and private adapter. Opaque project
identity remains a Phase E admission concern; the built-in adapter currently
authorizes exact registered paths.

## Implemented capability slice: Skill Installation

The Skills frontend now uses `shipctl.skill-installation@2` through the exact
activation supplied to project actions and lifecycle hooks. The public API
accepts a plugin-owned catalog, inspects installation state, and installs or
removes a caller-selected source by stable skill identity. Only the trusted
platform adapter knows the private command names and path-backed project
argument.

The built-in catalog and install workflow run against a Tauri-free fake host.
Generated properties cover catalog mapping, stable errors, request validation,
cancellation before dispatch, exact activation and correlation attribution,
disposal, mutation state, and fake-host traces. Native tests characterize exact
registered-root authority. Installation publishes `SKILL.md` with an atomic
same-directory rename and rolls it back if its compatibility pointer cannot be
published. Removal first moves every owned public path to a transaction-private
name, so a staging failure restores the prior visible state.

Phase D moved the reviewed mechanics to the Tauri-free native provider and
deleted the Skills Rust module, host adapter, Cargo feature, Tauri plugin, ACL
projection, and old private command edge. The TypeScript plugin now owns the
built-in catalog and Markdown sources. Phase E must still replace path-backed
project arguments with opaque admitted identities before third-party artifacts
receive this capability.

## Implemented capability slice: Credential Store for Assistants

Assistant Pi API-key inspection, save, and deletion now use
`shipctl.credential-store@1` through the launcher activation. The public API
uses opaque namespaced identities. It returns only configured state. The fake
provider and its traces never retain secret values.

The trusted adapter checks the exact activation, requested grant, and Pi
credential namespace before it calls the transitional Assistant commands. It
maps native failures to redacted stable errors. `get_pi_config` no longer reads
or migrates Keychain values as a hidden side effect. The Assistant module still
imports Tauri for its other operations, so this slice does not remove its
legacy-import ledger entry.

Generated properties cover absent credentials, save and delete transitions,
denial, invalid scope, cancellation before dispatch, disposed activations,
exact activation and correlation attribution, one-dispatch semantics, and
secret redaction from results, failures, and fake traces. Phase D must move the
native provider and authorization ledger into the native kernel before
third-party artifacts receive credential grants.

## Implemented capability slice: Usage Sources

The Usage frontend now uses `shipctl.usage-sources@1` through its exact module
activation. The public API exposes redacted source snapshots, scoped refresh,
and a source-change event. It does not expose native source paths, credentials,
Tauri commands, or the compatibility message frame. The module package no
longer imports or depends on Tauri.

The trusted adapter authorizes source identities before dispatch and converts
the existing `usage.ingest-completed` message into a leased semantic event.
Generated properties cover snapshot and overview mapping, diagnostic
redaction, stable errors, invalid requests, grant decisions, cancellation,
exact activation and correlation attribution, source filtering, event order,
lease disposal, and Tauri-free fake-host workflows.

The current native overview query remains behind the explicitly named
`legacy-overview-projection`. This is migration scaffolding, not a permanent
capability operation. Phase D must move usage aggregation and alias policy to
TypeScript, move provider credential and filesystem authority to the native
kernel, and then delete this projection and the feature-owned Rust crates.

## Implemented capability slice: Plugin Data

Commands and Usage settings now use `shipctl.plugin-data@1` through their exact
module activations. The public API exposes scoped records, schema versions,
compare-and-write revisions, atomic migration batches, and migration
provenance. It exposes no path, file handle, database handle, Tauri command, or
generic storage operation. The former broad global and project data host ports
are deleted.

The native kernel owns `plugin-data.json`, atomic publication, conflict checks,
project registration checks, and an exact initial record-admission catalog.
The catalog admits only the Usage global `settings` record and Commands project
`commands` records. It is the initial record-count quota. No byte limit is
invented without an authoritative product value or measured storage evidence.
Plugins own each admitted value's schema and interpretation.

Existing Usage and Commands YAML remains a read-only legacy source. A legacy
record appears at revision zero. The first successful compare-and-write creates
revision one in the new document and leaves the old YAML unchanged. An older
build can still read its unchanged legacy value after downgrade, but it cannot
see edits made after cutover. This limitation is explicit and avoids corrupting
the old format.

Generated properties cover exact activation and correlation attribution,
denial, invalid values, cancellation before dispatch, disposal, stable errors,
fake/native state parity, create-versus-replace conflicts, replacement of an
activation, multi-record migration atomicity, replay, and provenance. Native
tests also prove catalog isolation, legacy cutover, stale-write preservation,
and batch atomicity. Snapshot validation rejects malformed durable documents.

This slice provides application-process atomicity. It does not yet coordinate
an unrelated Shipctl process or external editor. That broader global-state
problem remains tracked separately. Phase D must replace the trusted
same-realm authorization catalog with the admitted native activation ledger
before third-party artifacts receive this capability.

## Implemented capability slice: Messages

The existing typed router is now exposed as `shipctl.messages@1`. Modules use
their activation service lookup for directed send, scoped publish, and
capability-port request operations. `ModuleHost` no longer contains the
parallel optional `messages` field. Static message declarations remain module
contributions because the host must compile and admit the complete route graph
before activation.

The trusted adapter binds one private bridge client to the exact module and
activation identity. Every outgoing envelope carries the semantic correlation
identity. Operations use cancellation before dispatch and never retry because
message delivery is not proven idempotent. Native diagnostic codes become
stable, redacted service errors, and malformed or identity-substituted replies
are rejected. No command name, Tauri channel, bridge ID, or raw invoke function
enters the public API.

Service binding owns frontend route cleanup. Activation disposal immediately
removes its directed handlers, topic subscriptions, and port handlers from
frontend dispatch. Native graph teardown remains atomic at bridge close or
reconciliation. A module whose activation fails is therefore unable to receive
later frames even if its route was in the admitted startup snapshot.

The Tauri-free fake models the current directed, publish, and request graph,
exact grants, encoded payload bounds, ordered delivery, and activation-owned
route removal. Seeded properties cover exact activation and correlation
attribution, cancellation suppression, one-dispatch semantics, stable redacted
failures, invalid replies, ordered fake delivery, grant and bound denial,
subscription cleanup, and stale-handler rejection. The native Rust router
remains the final JSON Schema, grant, capacity, route-generation, and
diagnostic authority.

## Normative semantics

- **SEM-B-001:** A plugin source package and built artifact must not resolve an
  import of `@tauri-apps/*`, `@shipctl/core`, a private IPC path, Layman, or
  another plugin implementation.
- **SEM-B-002:** A public service operation uses semantic names and values; it
  does not expose a Tauri command, channel, event, or store type.
- **SEM-B-003:** The trusted adapter preserves characterized success, error,
  cancellation, ordering, and subscription behavior until a deliberate
  semantic change is specified.
- **SEM-B-004:** Every service call is attributable to one activation identity
  before native grant enforcement becomes mandatory.
- **SEM-B-005:** A module can run against an in-memory service implementation
  in a DOM-free or browser harness, according to its responsibilities.
- **SEM-B-006:** Tauri imports in permanent frontend code exist only under
  `core/frontend/platform`.
- **SEM-B-007:** Public services distinguish bounded requests, discrete
  events, and high-volume ordered streams. A generic invoke or event escape
  hatch is forbidden.
- **SEM-B-008:** A request has one typed outcome, a stable semantic error, a
  correlation identity, and stated cancellation and retry behavior.
- **SEM-B-009:** An event subscription is scoped to one activation and lease.
  Disposal prevents later delivery through that lease.
- **SEM-B-010:** An ordered stream defines attachment identity, sequence,
  credit, acknowledgement, replay bounds, and disconnect behavior. The stream
  does not use the general event bus.

## Service slices

The first API should be capability-oriented, not one generic native bridge:

| Service | Initial consumers | Existing implementation wrapped first |
| --- | --- | --- |
| `processes` | ports, assistants | port scan/terminate and command availability commands |
| `git` | Git | Git command set and repository change event |
| `projectDocuments` | TODOs, skills | current TODO and skill commands while their policy is separated |
| `assistantLaunch` and `credentials` | assistants | current assistant session and Pi configuration commands |
| `usageSources` and plugin data | usage | current usage query, ingest, and snapshot commands |
| `messages` | usage, scheduler, later plugins | current typed native router and frontend bridge |
| `scheduler` | usage, later headless plugins | current durable scheduler and typed message targets |
| `semanticTerminals` | semantic terminal | current semantic attachment, input, history, anchor, selection, and metrics commands |

The service names and exact method sets require capability records. A service
must not become a permanent feature-specific dumping ground merely because it
is the first adapter over a legacy command.

## Migration order

Migrate one client at a time in increasing behavioral risk:

1. ports;
2. TODOs;
3. skills;
4. usage;
5. assistants;
6. Git, including native event replacement;
7. semantic terminal, including its dedicated ordered stream.

The order reflects observed call surface and resource sensitivity. A slice can
move earlier when its characterization proof is ready. Commands and thin
terminal already use host services and act as reference consumers.

## Work per service

1. Inventory current calls, payloads, events, errors, cancellation, and native
   authority.
2. Add JSON-safe service values and interface to `module-api/frontend`.
3. Add a fake implementation and consumer contract suite.
4. Implement a trusted adapter under `core/frontend/platform` over current
   private Tauri calls.
5. Bind activation identity at the adapter boundary.
6. Replace the module's direct client imports.
7. Remove its Tauri dependency and command constants from the frontend package.
8. Tighten the AST rule so the old import cannot return.
9. Repeat for trusted Tauri imports outside `platform`.

## Property cards

### PROP-B-BOUNDARY-001

- **Claim:** Every generated source import graph is accepted exactly when all
  plugin edges target the plugin API, Cordis, React peers, approved shared UI
  packages, or artifact-local code.
- **Shape:** safety.
- **Evidence:** SEM-B-001, SEM-B-006.
- **Domain:** generated package graphs with relative paths, package exports,
  deep imports, aliases, dynamic literal imports, and forbidden package names.
  Exclude non-literal runtime-computed imports; artifact admission handles
  those separately.
- **Preconditions:** files parse as TypeScript or TSX.
- **Oracle:** a test-only graph classifier based on normalized resolved package
  ownership, independent of the production diagnostic rule implementation.
- **Failure value:** a plugin hides `@tauri-apps/api/core` behind a local barrel
  and passes the source check.
- **Tier:** pull request.
- **Current status/test ID:** implemented /
  `architecture.plugin-imports.property`.

### PROP-B-ADAPTER-001

- **Claim:** For every generated request in a migrated operation's characterized
  domain, the semantic adapter and legacy client produce equivalent normalized
  results and errors over the same fake transport trace.
- **Shape:** differential.
- **Evidence:** SEM-B-002, SEM-B-003.
- **Domain:** valid and invalid requests, transport errors, cancellation, empty
  results, Unicode paths, and boundary numeric values permitted by the current
  operation. Each capability record states its exclusions.
- **Preconditions:** both paths receive the same recorded transport responses.
- **Oracle:** compare normalized public result and ordered transport trace. The
  fake transport is outside both clients.
- **Failure value:** a new Git adapter maps a native missing-repository error to
  a generic failure and breaks existing UI recovery.
- **Tier:** pull request.
- **Current status/test ID:** generator-ready; the Processes, Git, Skill
  Installation, and Credential Store slices pass /
  `architecture.service-adapter.service.property`. The Project Documents slice
  passes the same shared property over document discovery, mapping, stable
  errors, and exact request envelopes. Git passes the same shared property for
  status, worktree, changed-file, diff-stat, and stable-error mapping. Skill
  Installation passes for catalog DTOs, stable errors, and exact envelopes.
  Credential Store passes for redacted results, stable redacted errors, and
  exact authorized envelopes. Usage Sources passes for redacted snapshots,
  legacy projection parity, stable errors, and exact authorized envelopes.
  Plugin Data passes for JSON-safe value mapping, stable errors, and exact
  authorized envelopes. Scheduler passes exact bridge, activation, correlation,
  stable-error, and invalid-response checks as
  `architecture.service-adapter.scheduler.property`.

### PROP-B-FAKE-001

- **Claim:** Every generated module workflow that uses only a declared service
  can execute with an in-memory implementation without touching a Tauri proxy.
- **Shape:** safety.
- **Evidence:** SEM-B-005.
- **Domain:** generated consumer actions for each service contract. Exclude DOM
  rendering that belongs to browser component tests.
- **Preconditions:** required service bindings are present.
- **Oracle:** a Tauri access trap remains untouched and the fake's independent
  operation log equals the generated action model.
- **Failure value:** a view still imports a native event listener outside its
  nominal client file.
- **Tier:** pull request.
- **Current status/test ID:** generator-ready foundation /
  `architecture.plugin-service-fake.property`. Capability workflows remain in
  their service slices. The Project Documents workflow passes as
  `architecture.project-documents-service-fake.property`; Git passes as
  `architecture.git-service-fake.property`; Skill Installation passes as
  `architecture.skill-installation-service-fake.property`; Credential Store
  passes as `architecture.credential-store-service-fake.property`; Usage
  Sources passes as `architecture.usage-sources-service-fake.property`; Plugin
  Data passes as `architecture.plugin-data-service-fake.property`; Messages
  passes differential bridge/fake traces as
  `architecture.messages-bridge-parity.property`; Scheduler passes fake/current
  registration and inspection traces as
  `architecture.scheduler-adapter-parity.property`.
  Terminal Sessions passes focus, key input, paste input, resize, exit, and
  disposal histories as
  `architecture.terminal-sessions-service-fake.property`; the current trusted
  adapter is covered by
  `terminal-session adapter preserves attribution, request order, and cancellation`.

### PROP-B-ACTIVATION-001

- **Claim:** Every semantic service request emitted by a generated activation
  is tagged with that exact activation identity and never with another live or
  disposed identity.
- **Shape:** safety.
- **Evidence:** SEM-B-004.
- **Domain:** concurrent generated activations, service calls, disposal, and ID
  reuse attempts. Exclude native authorization decisions, which Phase D tests.
- **Preconditions:** activation identities are unique.
- **Oracle:** the test retains the activation that issued each action and
  compares it with the adapter's captured request envelope.
- **Failure value:** a replaced plugin continues to call Git with its
  predecessor's authority.
- **Tier:** pull request.
- **Current status/test ID:** implemented /
  `architecture.service-activation.property`. Scheduler also proves exact
  activation attribution and release with
  `architecture.service-event.scheduler.property`.
  Terminal Sessions proves activation-scoped lifecycle order and lease cleanup
  as `architecture.service-event.terminal-sessions.property`.

### PROP-B-REQUEST-001

- **Claim:** For every generated bounded-request history, the public result and
  private transport trace equal the independent request-state model.
- **Shape:** state-machine.
- **Evidence:** SEM-B-003, SEM-B-004, SEM-B-007, SEM-B-008.
- **Domain:** valid and invalid payloads, admitted and disposed activations,
  grant and scope decisions, unique correlation IDs, transport failure,
  cancellation before dispatch, cancellation during execution, settlement,
  and only the retries allowed by the capability record.
- **Preconditions:** the capability record states cancellation, retry, and
  idempotency semantics for the generated operation.
- **Oracle:** a pure request model accepts commands in generated order and
  records one of denied, cancelled, failed, or succeeded plus the permitted
  native-dispatch count. It shares no adapter or transport code.
- **Failure value:** a cancelled process-termination request executes after the
  caller has received cancellation.
- **Tier:** pull request.
- **Current status/test ID:** generator-ready foundation /
  `architecture.service-request.service.property`. Each capability still needs
  its full policy domain and differential oracle. The Processes slice now
  covers stale identities, denial, pre-dispatch cancellation, dispatch count,
  and request attribution. The Git slice covers invalid paths and values,
  pre-dispatch cancellation, exact activation and correlation, disposal, and
  dispatch count. The Project Documents slice covers invalid paths,
  stale revisions, exact activation and correlation attribution, cancellation,
  disposal, and dispatch count. Skill Installation covers invalid project and
  skill identities, cancellation, exact activation and correlation,
  disposal, dispatch count, and mutation receipts. Credential Store covers
  grant and namespace denial, redacted transport failures, cancellation,
  disposal, exact attribution, and one-dispatch semantics.
  Usage Sources covers invalid provider and window scopes, grant denial,
  cancellation, disposal, exact attribution, and one-dispatch semantics.
  Plugin Data covers grant and namespace denial, invalid values and revisions,
  cancellation, disposal, exact attribution, conflicts, migration replay, and
  one-dispatch semantics. Messages covers typed send, publish, and request;
  invalid replies; redacted failures; cancellation; disposal; exact activation
  and correlation attribution; and one-dispatch semantics. Scheduler covers
  pre-dispatch cancellation, disposal, grant denial, conflicts, exact
  activation and correlation attribution, and stable redacted failures in
  `architecture.service-request.scheduler.property` and its adapter property.
  Terminal Sessions covers attachment ownership, ordered key and paste input,
  native dimension bounds, cancellation, disposal, exact activation and
  correlation attribution, and stable redacted transport failures in its fake
  property and trusted-adapter suite.

### PROP-B-EVENT-001

- **Claim:** For every generated event log and subscription history, each
  consumer observes exactly the ordered events allowed by its scope before its
  lease ends.
- **Shape:** state-machine.
- **Evidence:** SEM-B-003, SEM-B-004, SEM-B-007, SEM-B-009.
- **Domain:** subscriptions before and after activation, matching and
  non-matching scopes, duplicate payload values, concurrent publishers,
  replacement, cancellation, and disposal. Exclude ordered terminal bytes,
  which use the stream contract.
- **Preconditions:** source events have a stable source identity and order as
  defined by the capability record.
- **Oracle:** retain the generated source log and use an independent scope and
  lease filter to compute each expected consumer sequence.
- **Failure value:** a disposed Git plugin receives a repository-change event
  through its old listener.
- **Tier:** pull request.
- **Current status/test ID:** generator-ready foundation /
  `architecture.service-event.service.property`. Git passes its capability
  slice with exact source identity, scope filtering, order, and disposal.
  Usage Sources passes the same event properties for provider source scopes.
  Scheduler passes generated fake-clock histories, exact occurrence order, and
  lease disposal as `architecture.service-event.scheduler.property`.
  Terminal Sessions passes generated lifecycle histories as
  `architecture.service-event.terminal-sessions.property`.

### PROP-B-STREAM-001

- **Claim:** For every generated attach, frame, credit, acknowledgement,
  disconnect, and reattach history, the consumer-visible sequence equals the
  independent ordered-stream model.
- **Shape:** state-machine.
- **Evidence:** SEM-B-003, SEM-B-007, SEM-B-010.
- **Domain:** empty and non-empty frames, boundary sequence values, duplicate
  and delayed frames, bounded credit, acknowledged and unacknowledged replay,
  detach, reconnect, and presentation replacement. Exclude OS process failure,
  which the terminal provider integration suite covers.
- **Preconditions:** the generated stream starts from a valid attachment and a
  retained replay bound from its capability record.
- **Oracle:** a pure deque model owns expected sequence, outstanding credit,
  acknowledgement, and retained replay independently from terminal and
  transport implementations.
- **Failure value:** a semantic terminal silently drops output during
  backpressure or replays a command twice after reattachment.
- **Tier:** pull request, with packaged terminal integration at release.
- **Current status/test ID:** generator-ready foundation /
  `architecture.service-stream.semantic-terminal.property`. The packaged PTY
  canary remains required before the semantic-terminal deletion gate closes.
  The raw Terminal Sessions slice passes generated exact-byte, credit,
  acknowledgement, gap, reattach, and disposal histories as
  `architecture.service-stream.terminal-sessions.property`. Its raw stream has
  zero replay retention: reattachment at the live boundary continues without
  replay, while an older acknowledged boundary reports a gap before live
  delivery.

## Exit proof

- `rg` and the AST checker find no Tauri import outside
  `core/frontend/platform`;
- no module frontend package declares a Tauri dependency;
- all seven migrated modules run their service contract tests with fakes;
- direct native event listeners are represented as semantic subscriptions;
- static app behavior and module characterization tests remain green;
- no Rust module has moved yet, so rollback is an adapter-level change.

## Deletion gate

Delete each module `client.ts`, native event listener, and Tauri package
dependency only after its adapter differential property and browser-fake
property pass. Delete non-platform trusted Tauri imports only after their
semantic adapter has equivalent lifecycle coverage.
