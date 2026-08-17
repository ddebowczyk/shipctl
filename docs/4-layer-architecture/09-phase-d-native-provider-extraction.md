# Phase D: native provider extraction

## Outcome

Move native authority from feature module crates into named platform
capabilities while keeping feature policy in TypeScript plugins. Remove one
module's Rust crates only after its service and ownership properties pass.

This phase is a repeated vertical slice, not one large relocation.

## First pilot: ports

Ports has two native operations and a small frontend. Its split is clear:

- process inspection and authorized termination move to
  `core/backend/src/processes/`;
- Tauri wrappers move to `core/tauri/src/processes.rs`;
- the ports plugin keeps list presentation, refresh workflow, action wording,
  and notices;
- `src-tauri` registers the permanent process adapter;
- the `ports-module` Cargo feature, backend crate, host crate, and ACL module
  projection are deleted after parity.

This slice proves the extraction method before it touches terminal continuity,
assistant sessions, Git watching, or usage persistence.

The pilot is now implemented. Ports has no backend crate, host crate, Cargo
feature, Tauri plugin registration, or ACL projection. The replayable proof is:

```sh
just --justfile ops/architecture/justfile ports-extraction
```

This completes the Ports native-extraction slice. Ports still uses static
frontend activation. Todos, Git, Skills, Semantic Terminal, Usage, and
Assistants are the next completed slices.

## Second slice: Todos

The Todos extraction is also implemented:

- registered-project lookup, normalized relative paths, bounded discovery,
  UTF-8 reads, revision comparison, and atomic publication now belong to
  `core/backend/src/project_documents/`;
- `core/tauri/src/project_documents.rs` contains only private request-envelope
  validation and command delegation;
- Todo parsing, ordering, checkbox mutation, board moves, conflict handling,
  and presentation remain in `modules/todos/frontend/`;
- activation disposal revokes native access but preserves every project-owned
  document;
- the Todos backend crate, host crate, Cargo feature, Tauri plugin, ACL
  projection, and legacy private command edge are deleted.

The replayable proof is:

```sh
just --justfile ops/architecture/justfile todos-extraction
```

Todos still uses static frontend activation. Its path-backed `ProjectRef.id`
also remains a trusted-host compatibility detail until Phase E admission
introduces opaque project identities for third-party artifacts.

## Third slice: Git

The Git extraction is implemented:

- scoped repository execution and stable errors now belong to the Tauri-free
  provider in `core/backend/src/git/`;
- `core/tauri/src/git.rs` validates private request envelopes and delegates
  every operation without feature workflow or presentation policy;
- Git projections, workflow, refresh policy, commands, and views remain in
  `modules/git/frontend/`;
- exact registered project paths, module grants, and activation disposal are
  enforced before native work;
- the host-wide project watcher remains a permanent core resource, while each
  Git event subscription is filtered by project and owned by its activation;
- the Git backend crate, host crate, Cargo feature, Tauri plugin, ACL
  projection, and namespaced private commands are deleted.

The replayable proof is:

```sh
just --justfile ops/architecture/justfile git-extraction
```

Git still uses static frontend activation. Phase E will replace that static
composition edge; it does not need another native migration.

## Fourth slice: Skills

The Skills extraction is implemented:

- registered-project authorization, stable skill-identity validation, safe
  directory traversal, atomic `SKILL.md` publication, compatibility-pointer
  publication, rollback, and safe removal belong to the Tauri-free provider in
  `core/backend/src/skill_installation/`;
- `core/tauri/src/skill_installation.rs` validates private request envelopes
  and delegates without a skill catalog or feature workflow policy;
- the TypeScript plugin owns built-in identities, titles, descriptions,
  source selection, Markdown, install workflow, commands, notices, and views;
- activation disposal revokes native access but preserves project-owned skill
  files;
- the Skills backend crate, host crate, Cargo feature, Tauri plugin, ACL
  projection, and namespaced private commands are deleted.

The public contract is `shipctl.skill-installation@2`. Version 2 makes the
caller-supplied catalog and source explicit. This prevents a permanent Rust
provider from compiling feature identities or Markdown into the host.

The replayable proof is:

```sh
just --justfile ops/architecture/justfile skills-extraction
```

Phase D left Skills on static frontend activation. Phase E has now replaced
that edge with the immutable artifact path; it did not require another native
migration.

## Fifth slice: Semantic Terminal

The Semantic Terminal extraction is implemented:

- the Ghostty-backed parser, projection, input encoding, native driver, and
  activation-scoped authority now belong to the Tauri-free provider in
  `core/backend/src/semantic_terminal/`;
- `core/tauri/src/semantic_terminal.rs` validates attributed private request
  envelopes, supplies the event channel, and delegates without feature policy;
- every native request carries module, activation, and correlation identity;
  terminal ownership and attachment leases are checked again below the
  TypeScript wall;
- activation disposal releases presentation attachments but preserves the
  host-owned PTY and terminal identity;
- the TypeScript module still owns semantic interaction, browser presentation,
  flow control, selection, clipboard behavior, and view policy;
- the Semantic Terminal backend, core, and host crates, Cargo feature, Tauri
  plugin, ACL projection, and namespaced private commands are deleted.

The lean CLI imports the permanent parser contract through `shipctl-core`; it
does not link Tauri or the desktop shell.

The replayable proof is:

```sh
just --justfile ops/architecture/justfile semantic-terminal-extraction
```

Semantic Terminal still uses static frontend activation. Phase E will replace
that edge. The host-owned terminal continues across presentation replacement.

## Sixth slice: Usage

The Usage extraction is implemented:

- reviewed filesystem, credential, subprocess, network, and SQLite authority
  now belongs to the Tauri-free provider in `core/backend/src/usage_sources/`;
- `core/tauri/src/usage_sources.rs` validates private request envelopes and
  delegates source inspection, refresh, and activation disposal;
- provider pricing, aliases, aggregation, projections, refresh workflow,
  schedules, messages, and views remain in `modules/usage/frontend/`;
- activation disposal revokes source access while preserving durable usage
  records owned by the host;
- the Usage backend crate, host crate, Cargo feature, Tauri plugin, ACL
  projection, and namespaced private commands are deleted.

The replayable proof is:

```sh
just --justfile ops/architecture/justfile usage-sources
```

Usage now uses the common immutable artifact and live-reconciliation path. Its
Phase D provider remains the permanent native authority behind the public Usage
Sources service.

## Seventh slice: Assistants

The Assistants extraction is implemented:

- assistant launch, capture, recovery records, placement, labels, model
  inspection, and non-secret provider configuration now belong to the
  Tauri-free provider in `core/backend/src/assistant_launch/`;
- namespaced secret storage and non-disclosure now belong to the separate
  Tauri-free provider in `core/backend/src/credentials/`;
- private adapters in `core/tauri/src/assistant_launch.rs` and
  `core/tauri/src/credentials.rs` validate attributed request envelopes and
  delegate without React or provider-selection policy;
- activation disposal revokes access while preserving host-owned terminal,
  recovery, and credential resources;
- provider orchestration, launch workflow, labels, model choices, notices, and
  views remain in `modules/assistants/frontend/`;
- the Assistants backend crate, host crate, Cargo feature, Tauri plugin, ACL
  projection, and namespaced private commands are deleted.

Credential existence checks use Keychain status only. Secret bytes are not
returned to JavaScript or loaded for an existence check.

The replayable proof is:

```sh
just --justfile ops/architecture/justfile assistants-extraction
```

Assistants still uses static frontend activation. Phases E and F own immutable
artifact loading, replacement, and recovery adoption.

## Normative semantics

- **SEM-D-001:** Native code moves to core only when it owns OS authority,
  durable shared resources, or enforcement outside plugin JavaScript.
- **SEM-D-002:** Feature workflow, aggregation, labeling, presentation, and
  plugin data interpretation remain in the plugin.
- **SEM-D-003:** Public services authorize the activation, capability grant,
  and resource scope before native work occurs.
- **SEM-D-004:** Extracted providers preserve characterized behavior until a
  semantic record states a change.
- **SEM-D-005:** A native provider can be used without Tauri and its Tauri
  adapter contains no domain policy.
- **SEM-D-006:** Disabling or replacing a presentation plugin does not destroy a
  host-owned durable resource unless a separate explicit operation requests it.
- **SEM-D-007:** After a module cutover, no Rust workspace member, Cargo
  feature, Tauri plugin, ACL projection, or host adapter remains under that
  module.
- **SEM-D-008:** After all native module cutovers, no Rust compatibility crate
  remains under `module-api`; each surviving trait and value belongs to a
  named permanent capability under `core/backend` or a private adapter under
  `core/tauri`.

## Extraction protocol

For each native-backed module:

1. classify every exported command and background task as platform mechanism,
   feature policy, or transitional coupling;
2. record native resource ownership and persistence authority;
3. define the narrow service contract and effective grants;
4. create Tauri-free provider logic under `core/backend`;
5. add private Tauri adapters under `core/tauri`;
6. run the old and new providers against generated fixtures where behavior is
   intended to remain equal;
7. move feature policy to TypeScript over semantic services and plugin data;
8. switch the trusted service adapter to the new provider;
9. run integration, packaging, modularity, and agent inspection proofs;
10. remove the old crates and all build projections in the same closure slice.

After the last consumer moves, run the same protocol for
`module-api/backend`: classify each terminal, snapshot, and durable-write
contract; move it to the permanent capability that owns it; update core and
Tauri callers; then delete the `shipctl-module-api` crate and workspace edge.
This is a semantic ownership move, not a package rename.

The detailed proposed disposition is in
[Module disposition matrix](14-module-disposition-matrix.md).

## Property template for every provider

### PROP-D-PARITY-001

- **Claim:** For every generated request in the characterized domain, the
  extracted Tauri-free provider and legacy backend produce equivalent
  normalized results, state transitions, and durable writes.
- **Shape:** differential.
- **Evidence:** SEM-D-004, SEM-D-005.
- **Domain:** capability-specific valid and invalid requests over isolated
  temporary resources. Each record lists exclusions such as real credentials
  or OS behavior that needs an integration fixture.
- **Preconditions:** both providers begin from equivalent fixture state.
- **Oracle:** run providers in separate roots and compare public results and
  externally captured state. The comparison code is outside both providers.
- **Failure value:** extraction changes TODO ordering or Git path
  authorization while unit tests exercise only success.
- **Tier:** pull request.
- **First implementation/test ID:** Processes provider /
  `architecture.provider.processes.parity.property`.

### PROP-D-AUTHORITY-001

- **Claim:** For every generated activation, grant set, scope, and request, a
  native provider executes exactly when the independent authorization model
  allows that tuple.
- **Shape:** differential.
- **Evidence:** SEM-D-003.
- **Domain:** admitted and unknown activations, missing and excess grants,
  resource paths inside and outside scope, disposed identities, and valid
  requests. Exclude hostile same-realm code that bypasses the supported API.
- **Preconditions:** generated paths are normalized before policy evaluation.
- **Oracle:** a small rule-table model computes allow or deny without calling
  provider authorization code.
- **Failure value:** a disabled plugin can terminate an arbitrary process or
  read a repository outside its grant.
- **Tier:** pull request.
- **First implementation/test ID:** Processes provider /
  `architecture.provider.processes.authority.property`.

### PROP-D-OWNERSHIP-001

- **Claim:** Removing any generated plugin activation releases its leases but
  leaves every host-owned durable resource unchanged until an explicit
  destructive operation succeeds.
- **Shape:** conservation.
- **Evidence:** SEM-D-006.
- **Domain:** terminal sessions, watchers, background ingest leases, and plugin
  data handles with activation disposal and replacement. Exclude OS process
  death outside Shipctl control.
- **Preconditions:** resources declare host or activation ownership.
- **Oracle:** an independent ownership ledger predicts live resources and
  leases after each command.
- **Failure value:** replacing semantic terminal kills its PTY or losing usage
  UI deletes its durable data.
- **Tier:** pull request, with terminal cases also in release verification.
- **First implementation/test ID:** Processes provider /
  `architecture.provider.processes.ownership.property`.

### PROP-D-CLOSURE-001

- **Claim:** The native graph contains only declared authority providers and
  adapters. Every module marked native-extracted keeps feature policy in
  TypeScript and contains no Rust, Cargo, Tauri plugin, ACL, or private command
  edge.
- **Shape:** safety.
- **Evidence:** SEM-D-001, SEM-D-002, SEM-D-007, SEM-D-008.
- **Domain:** generated architecture snapshots and mutation fixtures that add
  one forbidden residual edge at a time. Exclude historical ignored plans.
- **Preconditions:** the module disposition record has no current native crates
  and records completion of the native-extraction compatibility path. The
  overall module can remain `migrating` while later dynamic-activation work is
  still open.
- **Oracle:** a closed list of allowed target owners in the normative record is
  compared with resolved source, Cargo, and ACL graphs.
- **Failure value:** the frontend moved but `src-tauri` still rebuilds a hidden
  module plugin.
- **Tier:** pull request.
- **First implementation/test ID:** Ports extraction /
  `architecture.native-extraction-closure.property`.

## Ports-specific properties

- Generated process tables preserve the characterized listening-port
  projection. Ports applies development-process, project matching, and
  framework policy in TypeScript.
- Termination is attempted only for a process from the authorized inspection
  snapshot and fails closed when the PID identity is stale.
- Repeating a successful termination request cannot target a different process
  that reused the PID without a new identity proof.

These become separate full property cards in the `processes` capability record.

## Exit proof per module

- service boundary and fake consumer suite pass;
- legacy/new differential or stated semantic replacement properties pass;
- native grant and scope properties pass;
- CLI and Tauri adapters use the same Tauri-free provider where applicable;
- packaged app characterization passes;
- agent inspection shows provider, grant, activation, and resource owner;
- all old Rust and build projections named by the disposition record are gone.
- the final native slice also proves that `module-api/` contains no Rust crate
  and no core caller depends on `shipctl-module-api`.

## Phase relationship

Ports, Todos, Git, Skills, Semantic Terminal, Usage, and Assistants have proved
the native extraction method. Final wall closure now waits for the shared Rust
compatibility API deletion gate. Artifact work can proceed independently.
