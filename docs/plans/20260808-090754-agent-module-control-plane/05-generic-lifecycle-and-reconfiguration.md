# Phase 5 — generic lifecycle and reconfiguration

## Outcome

Complete one module-agnostic lifecycle for add, enable, update, disable, remove,
rollback, and reconfigure. An operation is successful only when its durable and
runtime results are both inspectable and consistent.

## Work package 5.1 — lifecycle command surface

Add commands over the same registry service:

```text
shipctl modules enable <module-id> [--artifact <digest>]
shipctl modules disable <module-id>
shipctl modules remove <module-id> [--artifact <digest>]
shipctl modules rollback <module-id> --artifact <digest>
shipctl modules reconfigure <module-id> --patch <json-or-file> --scope <scope>
shipctl operations inspect <operation-id>
shipctl operations watch <operation-id>
shipctl modules events --after <registry-revision>
```

Every mutation accepts a request id for safe retries and an expected revision
or digest for optimistic concurrency when the caller needs compare-and-swap
semantics. A conflict returns current facts; it never overwrites newer work.

Submission returns an operation and target registry revision. `operations
watch` streams the same durable transitions until a terminal result or caller
disconnect. The operation continues if the observing CLI disconnects.

## Work package 5.2 — lifecycle semantics

Apply these generic rules:

<!-- markdownlint-disable MD013 -->

| Operation | Durable commit | Runtime behavior |
| --- | --- | --- |
| Add | Record validated disabled artifact | None |
| Enable | Select installed digest | Prepare and publish instance |
| Update | Select B while A remains observed | Prepare B, swap, drain A |
| Disable | Select no active digest | Unpublish, route no new work, drain |
| Remove | Drop desired/install reference | Disable semantics, then collect artifact |
| Rollback | Select retained digest A | Same prepare-and-swap path |
| Reconfigure | Commit validated config revision | Apply live or reject before commit |

<!-- markdownlint-enable MD013 -->

Logical removal completes when public behavior and new-work routing disappear.
Physical removal completes after old instance leases release and no registry or
operation references require the artifact. Both states are visible.

Do not add a generic force-close shortcut. A runtime kind or resource lacking a
safe drain or transfer contract is restart-required before desired state
changes.

## Work package 5.3 — configuration contract

Each module owns a versioned configuration schema. The manifest declares
supported scopes and classifies fields as:

- live apply;
- live apply with resource drain;
- restart-required; or
- secret, whose value is never returned by inspection.

The CLI target instance and configuration scope remain separate. A global
registry change can be reconciled by every running instance; a workspace-scoped
change is keyed by stable workspace identity and only applies where relevant.

Validate and prepare configuration before committing its revision. The module
receives an immutable effective snapshot and either atomically accepts it or
keeps its prior configuration. Inspection shows schema version, scope,
configuration revision, redacted effective values, and last apply result.

## Work package 5.4 — generic resource leases

Define a host resource adapter contract:

- acquire with exact `ModuleInstanceId` owner;
- route later actions to that owner;
- transfer only when the resource type explicitly supports it;
- release on natural completion; and
- report identity and drain state without exposing secrets.

Convert terminal-session action delivery from global broadcast to exact owner
routing. A terminal started by A remains leased to A while B handles new work.
PTY output continues through the unchanged host transport; lifecycle operations
must not kill it to complete quickly.

Apply the same contract to jobs, watchers, streams, and background tasks as each
kind enters a module manifest.

## Diagnostic and verification mechanism

Operation inspection exposes requested intent, preconditions, preflight,
durable revision, per-instance observations, transitions, blockers, rollback,
and result. Module verification can assert expected enabled state, digest,
configuration revision, applied registry revision, and absence or presence of
drain blockers.

The integration matrix exercises each lifecycle operation through the compiled
CLI against a running host. It includes idempotent replay, stale revision,
activation failure, configuration failure, disconnect during watch, draining
resource, natural release, and artifact collection.

## Exit proof

- Every command changes only the requested module and scope.
- Success returns the exact desired revision and matching observed evidence.
- Failed prepare or configuration leaves the prior active digest/config public.
- Disable and remove immediately stop new work without breaking leased work.
- Physical removal waits for the observed lease inventory to empty.
- Concurrent stale requests fail with current revision evidence.
- Replayed request ids do not duplicate mutations or activation.
- Settings UI mutations, when added, call the same service and produce the same
  operation records as CLI mutations.
- Existing repository gates remain green.

## Primary implementation areas

- `core/backend/src/module_control/` for operations and configuration storage;
- `core/frontend/host/` for reconciliation, config application, and leases;
- `core/frontend/terminal/terminalSessions.ts` for exact owner routing;
- `modules/api/` for resource and configuration contracts; and
- `ops/module-control/` for the generic lifecycle matrix.
