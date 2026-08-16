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
- **Initial status/test ID:** proposed template /
  `architecture.provider.<capability>.parity.property`.

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
- **Initial status/test ID:** proposed template /
  `architecture.provider.<capability>.authority.property`.

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
- **Initial status/test ID:** proposed / `architecture.resource-ownership.property`.

### PROP-D-CLOSURE-001

- **Claim:** The native graph contains only declared authority providers and
  adapters. Every module marked native-extracted keeps feature policy in
  TypeScript and contains no Rust, Cargo, Tauri plugin, ACL, or private command
  edge.
- **Shape:** safety.
- **Evidence:** SEM-D-001, SEM-D-002, SEM-D-007, SEM-D-008.
- **Domain:** generated architecture snapshots and mutation fixtures that add
  one forbidden residual edge at a time. Exclude historical ignored plans.
- **Preconditions:** the module disposition record says `native-extracted`.
- **Oracle:** a closed list of allowed target owners in the normative record is
  compared with resolved source, Cargo, and ACL graphs.
- **Failure value:** the frontend moved but `src-tauri` still rebuilds a hidden
  module plugin.
- **Tier:** pull request.
- **Initial status/test ID:** proposed / `architecture.native-extraction-closure.property`.

## Ports-specific properties

- Generated process tables filtered by project scope return the same visible
  rows before and after extraction.
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

After the ports pilot proves the method, other provider slices can proceed
independently of artifact work when their prerequisites are met. Final wall
closure waits for all seven native-backed modules.
