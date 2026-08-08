# Mid-project review — agent module control plane

**Recorded:** 2026-08-08. **Scope:** Steps 0A–0D and Phase 1 as implemented;
Phases 2–8 as planned. **Status:** advisory. Nothing here is a merge blocker
by itself; finding 1 is a correctness defect that should be settled before
Phase 2 depends on it.

## What exists today

Reviewed at `ebd626d` plus the working tree.

<!-- markdownlint-disable MD013 -->

| Area | Files | Size | State |
| --- | --- | --- | --- |
| CLI crate | `cli/src/{args,lib,instances,offline_modules,output}.rs` | ~2.2k lines | Instance commands + offline module read surface |
| Instance foundation | `core/backend/src/instance/{context,control,leases,protocol}.rs` | ~2.4k lines | Context, leases, local IPC, shutdown |
| State providers | `core/backend/src/state/{archive,paths,providers,ui}.rs` | ~1.6k lines | Snapshot archive, restore, injected paths |
| Module contracts | `core/backend/src/module_control/contracts.rs` | 780 lines | 0D schema v1, validated, golden fixtures |
| Registry | `core/backend/src/module_control/registry/` | ~1.8k lines | SQLite, transactional, diagnostics, tests |
| Live service | `core/backend/src/module_control/live.rs` | 614 lines | Runtime snapshot join, Phase 2 read path |
| Frontend loader | `core/frontend/host/moduleArtifactLoader.ts` | 136 lines | Digest-qualified import, React singleton check |
| Ops gates | `ops/{instance,module}-control/` | — | Loader tripwire, offline CLI, integration driver |

<!-- markdownlint-enable MD013 -->

Roughly 15k lines across the slice. The critical path is ahead of the phase
map: Phase 1's registry and offline CLI are landed, and Phase 2's protocol
framing and joined read model exist behind `ModuleControlService`.

## What is working well

These are load-bearing and should not be traded away in any simplification.

- **Validation lives in the type, not in a test.** `RedactedEvidence::validate`
  rejects unredacted secret material structurally, and every contract uses
  `deny_unknown_fields` with a schema-version gate. Diagnostic codes are shape-
  checked (`valid_diagnostic_code`). This is the right place for these rules.
- **The loader enforces its own tripwire.** `loadModuleArtifact` fails when
  `runtime.react !== React` or the marker does not round-trip, and
  `assertDigestQualifiedArtifactUrl` refuses any URL outside `/{digest}/`. The
  0D.4 React-identity proof is a production invariant rather than a one-time
  test result.
- **Registry crash behavior is genuinely tested.** `failed_write_rolls_back_…`,
  `failed_migration_transaction_preserves_…`, and
  `read_only_open_does_not_create_or_modify_registry_files` cover the exit
  proofs directly rather than by proxy.
- **Content digest plus desired/observed revision.** Cheap, and it is the whole
  reason an agent can prove which code is running. Keep it through every
  reduction below.

## Findings

### 1. Desired state is keyed by process incarnation, so it does not survive a restart

**Severity: correctness. Fix before Phase 2 builds on desired state.**

`InstanceContext::resolve` mints a fresh UUID per launch, exactly as Step 0A
specifies:

```text
core/backend/src/instance/context.rs:139   instance_id: Uuid::new_v4(),
```

That incarnation UUID is then used as the durable key for desired state:

```text
src-tauri/src/lib.rs:95   ModuleControlService::initialize(paths.clone(), context.instance_id)
```

`DesiredModuleState.instance_id` carries it, and the table is keyed on it:

```sql
PRIMARY KEY(instance_id, module_id)   -- registry/mod.rs:368
```

`ModuleControlService::initialize` then seeds every static module whose id has
no desired state *for this instance_id* (`live.rs:89-119`). On the next launch
the id is new, the `configured` set is empty, and all static modules are
re-seeded with `enabled: true`.

Consequences:

- Disabling a module does not survive a restart. The registry's core purpose —
  durable desired state — is defeated.
- Rows and revisions accumulate one set per boot, forever. There is no `DELETE`
  or prune anywhere in `registry/mod.rs`.
- The registry revision becomes a function of how many times the app has
  started, not how many meaningful changes occurred.

The contract's own doc comment states the intent: *"Desired selection for
exactly one **named** running Shipctl instance."* The implementation is
incarnation-scoped, not name-scoped.

Why tests miss it: `live.rs:559` reinitializes with `service.instance_id` — the
same id — and `registry/tests.rs:323` exercises `seed_static_inventory`, a
registry-scoped function, not the per-instance seeding path. No test reopens
with a different UUID.

**Recommendation — drop the key entirely.** The registry already lives under
`ShipctlPaths`, i.e. one registry per state root, and the state root *is* the
durable profile identity. Scoping desired state by instance inside a
per-state-root registry is redundant. Remove `instance_id` from
`DesiredModuleState` and from the `desired_state` primary key; keep it on
`ObservedModuleState`, where per-incarnation scoping is correct because
observations are runtime facts.

If the Phase 8.4 shared-registry scenario later becomes a real product
requirement, reintroduce a *durable* key — the instance name, or a UUID
persisted in the state root — never the incarnation UUID.

Mitigating context: `ModuleControlService` is currently gated behind
`module_loader_probe_enabled` (`lib.rs:91`), so this is not yet user-visible.
That makes it cheap to fix now and expensive to fix after Phase 5 writes
desired state on every lifecycle command.

Add a test that reopens the registry under a new incarnation UUID and asserts
that a disabled module stays disabled.

### 2. Artifact identity includes `source`, contradicting Phase 1

**Severity: contract violation.**

`insert_immutable_artifact` compares serialized identity JSON:

```text
registry/mod.rs:607-615
  Some(existing) if existing == identity_json => Ok(()),
  Some(_) => Err(REGISTRY_ARTIFACT_IMMUTABLE),
```

`ModuleIdentity` includes `source` (`bundled` / `user` / `development`), so
re-adding byte-identical content under a different source is rejected as an
immutability violation. Phase 1 WP 1.2 says the opposite: *"Source affects
trust and replacement policy, never identity."*

This will bite in the Phase 7 dev loop, where the same content can plausibly
arrive as `development` and later as `user` or `bundled`.

Second problem in the same lines: identity comparison depends on byte-exact
serde output. Field order is stable today because it follows declaration order,
but adding an optional field or reordering the struct silently changes stored-
versus-computed equality. Content-addressing exists precisely so that identity
is the digest.

**Recommendation:** compare `content_digest`, not JSON. Store `source` and
provenance as mutable attributes of the artifact record. Apply the same change
to `require_artifact` (`registry/mod.rs:711`), which has the identical
whole-JSON comparison.

### 3. Boot commits one revision per module

`ModuleControlService::initialize` loops over missing modules and calls
`registry.commit(...)` once each, with a fresh `Uuid::new_v4()` request id per
module (`live.rs:102-119`). With eight static modules, a first boot burns eight
revisions and eight journal entries for something no agent requested.

The random request id also means the seed is not idempotent by request id — it
is idempotent only via the `configured` pre-check, which finding 1 shows is
itself unreliable.

**Recommendation:** seeding is not a user intent and should not enter the
operation journal. Either commit the whole seed as one mutation with a
deterministic request id derived from the build identity, or treat static
inventory as a *read-time overlay* — the registry stores only genuine
deviations from build defaults, and inspection materializes the rest. The
overlay approach is strictly simpler: it makes the registry empty on a fresh
install, which is an honest representation of "nothing has been configured."

### 4. The registry is a JSON document store wearing a database

**Severity: complexity. Highest simplification payoff.**

Every table stores a `*_json` blob alongside extracted scalar columns:

```sql
artifacts(module_id, content_digest, identity_json)
desired_state(instance_id, module_id, selected_artifact_digest,
              configuration_revision, state_json)
observations(instance_id, module_id, observation_key, artifact_digest,
             applied_registry_revision, state_json)
operations(request_id, revision, instance_id, module_id, operation_json)
```

Reads go through `load_contracts<T: ModuleContract>` and parse the JSON
(`registry/mod.rs:771`). The scalar columns exist only to support foreign keys —
nothing reads them. There are no joins, no aggregates, and no indexes beyond
primary keys. The digest is stored three times per desired-state row: in the
artifacts row, in the FK column, and inside the blob.

Against the actual data volume — eight modules, one desired entry each, a
journal that grows at human/agent pace — this is tens of kilobytes. That is
921 lines of registry code plus a rusqlite dependency to manage a document that
fits in a single `serde_json::to_string_pretty` call.

The README justifies SQLite on *"atomic revisions, crash recovery, and safe
multi-process reads."* At this size all three are satisfied by writing one
canonical JSON document to a temp file and `rename`-ing it: the rename **is**
the revision boundary, readers take no lock at all and always observe a
complete revision, and writers serialize through the lease primitive already
built in Step 0C.

**Recommendation:** replace the SQLite backend with a single atomically-renamed
JSON document behind the existing repository boundary. The boundary is already
in place (`Access`, `RegistrySnapshot`, `RegistryMutation`), so this is a
backend swap, not a redesign. Expect the registry module to shrink by well over
half, and the crash tripwire tests to get easier — you control the write
boundary directly instead of trusting a WAL.

Two notes on alternatives:

- **redb is not the answer here.** It takes a process-level file lock
  (`DatabaseError::DatabaseAlreadyOpen` — *"The Database is already open.
  Cannot acquire lock."*), so `shipctl modules inspect --offline` would fail
  whenever `shipctl-ui` holds the registry. That breaks the entire Phase 1
  deliverable, which exists specifically to be readable from a second process.
- **Keep JSON, not YAML,** for machine-written state. It is already the
  canonical wire model, canonical serialization gives stable digests, and YAML's
  implicit typing is an active hazard for version strings and digests. YAML
  stays right for authored files: `module.yaml`, `config.yml`.

Revisit only if observations become high-frequency (supervisor heartbeats
rather than per-revision reports) — that is the one growth vector that would
change the arithmetic. Write that trigger into the plan so the decision is
measured rather than reversed by surprise.

### 5. Two read models for one concept

`OfflineModuleInspection` (`cli/src/offline_modules.rs:46`) and
`ModuleInspection` (`contracts.rs:464`) describe the same thing in different
shapes: the offline model has `artifacts: Vec<_>`, `desired: Vec<_>`,
`lastReportedObservations: Vec<_>`; the online model has singular `manifest`
and `desired` plus `observed: Vec<_>`.

The pluralization difference is defensible — offline spans instances, online is
scoped to one — but the consequence is that `modules inspect` and
`modules inspect --offline` return structurally different documents. Since the
plan's premise is that one agent proves its own result, that is a real cost.

Second issue: the offline envelopes derive `Serialize` only. No `Deserialize`,
no `deny_unknown_fields`, no `ModuleContract` impl, therefore no `validate()`.
Their nested types are validated contracts, but the outermost layer of every
offline response sits outside the 0D machinery — while Phase 1's exit proof
says *"Golden CLI outputs validate against the Step 0D module contracts."*

**Recommendation:** implement `ModuleContract` on the three offline envelopes so
the exit proof is literally true, and converge the two shapes on one
`ModuleInspection` where `observed` is empty offline and `runtimeAvailable` is
an envelope field in both modes.

### 6. Diagnostic codes have no single home

Codes are the stable public contract — 0D says *"codes and evidence fields may
not change without a schema-version decision"* — but they are declared across at
least four files: `contracts.rs` (7), `live.rs` (11), `registry/` (several), and
`cli/src/offline_modules.rs` (3).

`MODULE_ABSENT = "module.registry.module.absent"` is declared twice, in
`live.rs:17` and `offline_modules.rs:17`. Two independent definitions of one
contract value will drift.

**Recommendation:** one `codes.rs` owning every code as a constant, with a test
that enumerates them and asserts shape and uniqueness. Anything genuinely
crate-local is not a contract code and should not look like one.

### 7. Glob re-exports flatten three layers into one namespace

```text
core/backend/src/module_control/mod.rs
  pub use contracts::*;
  pub use live::*;
  pub use registry::*;
```

Contracts (pure data), registry (storage), and live (runtime join) are three
layers with different stability guarantees, collapsed into one import surface.
Callers cannot tell which layer they depend on, and a name added to one module
can silently shadow or collide with another — finding 6's duplicate constant is
the early symptom.

**Recommendation:** re-export `contracts` deliberately, since it is the public
vocabulary, and require `module_control::registry::` and `module_control::live::`
paths for the other two. It makes layer violations visible at the import site.

## Architectural opportunity: modules describe, host owns

The findings above are local. This one is structural, and it is the largest
available reduction in remaining scope. It is worth a deliberate decision
before Phase 4 starts, because it is reversible in one direction only.

Today `activate(host)` returns a **live runtime object**
(`moduleArtifactLoader.ts:123`). That single choice is what forces
`ActivationScope`, and most of Phases 4 and 5 exists to manage its
consequences.

For comparison, Zed's extension host — verified against
`crates/extension_host` and the `since_v0.6.0` WIT world — reloads extensions
live with none of that machinery. Its WIT world is a **closed set of exports**
(`language-server-command`, `run-slash-command`, `context-server-command`,
`get-dap-binary`, …) with no UI-rendering export at all. Extensions answer
questions; the host owns every durable thing that results. Reload is then
literally `wasm_extensions.retain(...)` followed by `WasmExtension::load()`,
guarded by a 100 ms watch latency and a 200 ms debounce.

That is not a runtime-technology difference. It is a *surface* difference.

If Shipctl modules returned declarative contributions — ids, kinds, and
component references — and the host performed the mounting, four things follow.

**Activation scope shrinks to almost nothing.** Of the six responsibilities
Phase 4.2 assigns it, contributions become host-owned, styles become host-
injected by digest, and subscriptions and timers inside components are disposed
by React's own unmount. Only native channel handles and leases remain. The rest
is reimplementing unmount semantics React already provides.

**Drain mostly disappears.** Phase 5.4's lease protocol exists chiefly so a
terminal started by A survives a swap to B. If the host owns the PTY outright
and merely records which module instance requested it, routing is a lookup
rather than a drain negotiation — and the PTY outliving the module is what you
want anyway, since reload-safe reattachment is already tracked as separate
resilience work.

**Operations become synchronous.** The async machinery — `ModuleOperation`,
`ModuleTransition`, eight phases, `operations watch`, `modules events --after`,
"the operation continues if the observing CLI disconnects" — is justified by
operations being slow. Import and mount are not slow. Only drain is. Remove
drain and every lifecycle operation is a sub-second request/response. Keep an
append-only audit log; drop the transactional state machine.

**Phase 6 does not need all eight modules.** Phase 6 conflates *removable at
build time* — already proven by the existing modularity and plug-out gates —
with *swappable at runtime*, which is new. Nobody installs `git` at runtime; for
bundled features, enable/disable is a catalog visibility flag. Migrating
`fixture` plus one small real module such as `todos` keeps the artifact path
exercised by a real user without paying eight migrations.

Applying the plan's own necessity test — *deleting c leaves contract unmet or
unproven* — `operations watch` does not survive if no operation is slow enough
to watch.

Honest costs. Bundled features lose *physical* removal, which is probably not a
real need but is a change to the stated contract. `modules dev --watch` would
not work against a statically composed module, so if the dev loop's main target
is bundled features rather than `fixture`, that trade weakens considerably —
check this before committing. And the review assumes deleting static
`ENABLED_MODULES` composition is an internal goal rather than a hard
requirement; if something depends on it that is not visible in the plan pack,
the Phase 6 recommendation does not hold.

## Suggested order

1. **Finding 1** — desired-state keying. Correctness, and the cost of fixing it
   rises steeply once Phase 5 writes desired state on every command.
2. **Findings 2, 3** — artifact identity and boot revisions. Small, and both
   touch code that later phases will build on.
3. **Decide the architectural question above** before Phase 4 opens. It changes
   what Phases 4–6 contain.
4. **Finding 4** — registry backend swap. Independent of the rest; do it when
   convenient, but before the schema acquires a v2 that must be migrated.
5. **Findings 5, 6, 7** — read models, code ownership, module boundaries.
   Cohesion work, safe to batch.

## What not to change

- Content digest plus desired/observed revision reconciliation.
- Contract validation in the type, including secret-leakage rejection.
- The loader's React-singleton and digest-qualified-URL invariants.
- The 0C executable split and lease primitive, which the registry
  recommendation in finding 4 depends on.
