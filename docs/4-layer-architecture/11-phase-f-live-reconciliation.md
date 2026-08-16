# Phase F: live reconciliation

## Outcome

Install, enable, replace, disable, and remove TypeScript plugins while the
webview remains alive. Candidate failure leaves the last good activation and
complete runtime graph public.

This phase changes runtime membership. It starts only after static Cordis
lifecycle, one compound application artifact, and one headless service artifact
fixture are proven.

## State authorities

- Rust module registry owns desired plugin identity, artifact digest, enabled
  state, grants, and monotonically advancing revision.
- TypeScript application runtime owns applied revision, activation states,
  provisional graph, accepted service and contribution snapshots, and disposal
  state.
- The running-instance protocol exposes both. Neither notification text nor
  React state is an authority.

## Normative semantics

- **SEM-F-001:** The runtime processes desired revisions in order and never
  reports an older revision as applied after a newer one.
- **SEM-F-002:** A candidate graph remains private until all artifacts,
  dependencies, grants, registrations, and readiness checks pass.
- **SEM-F-003:** Publication changes service routes and all contribution
  catalogs atomically.
- **SEM-F-004:** Candidate failure preserves the last good public graph and
  records a stable diagnostic linked to the failed desired revision.
- **SEM-F-005:** Repeating an already applied desired snapshot does not create
  another activation or effect.
- **SEM-F-006:** Replacement uses a new digest-qualified module identity and
  routes new work before disposing the predecessor.
- **SEM-F-007:** Successful live transitions do not reload the webview or
  destroy host-owned resources.
- **SEM-F-008:** Applied inspection identifies every activation, contribution,
  service binding, grant, diagnostic, and resource lease by stable owner ID.
- **SEM-F-009:** Provider replacement validates all required-service bindings,
  atomically routes new calls to the accepted provider, and disposes the old
  provider only after it is no longer public.

## Reconciler shape

The Shipctl supervisor, not Cordis internals, owns this state machine:

```text
idle
  -> observing(revision)
  -> preparing(candidate)
  -> validating(candidate)
  -> ready(candidate)
  -> publishing(candidate)
  -> applied(revision)

preparing | validating | ready
  -> rejected(revision, diagnostic)
  -> last-good remains applied
```

Cordis creates and disposes instance fibers. Shipctl decides desired versus
applied revisions, candidate visibility, catalog atomicity, last-good policy,
and diagnostic records.

## Work

1. Add a typed registry revision subscription through the trusted platform.
2. Define a pure reconcile planner from current applied snapshot and desired
   snapshot to ordered operations.
3. Create candidate contexts and provisional registries outside public routing.
4. Validate service provider/consumer dependencies, grants, manifest/runtime
   equality, contribution references, and readiness.
5. Publish one immutable runtime snapshot and catalog family.
6. Route new calls to replacement activations.
7. Dispose replaced or removed activations and report drain state.
8. Keep the last-good snapshot and diagnostic on failure.
9. Expose structured `shipctl modules watch`, inspect, and operation status.
10. Exercise the full loop with fixture plugins before migrating terminal or
    assistant presentation.

## Property cards

### PROP-F-RECONCILE-001

- **Claim:** For every generated desired-state history, the applied runtime
  snapshot after each settled transition equals the independent reconcile
  model's last valid graph.
- **Shape:** state-machine.
- **Evidence:** SEM-F-001, SEM-F-002, SEM-F-004, SEM-F-005, SEM-F-006.
- **Domain:** add, enable, replace, disable, remove, repeated revisions, stale
  revisions, dependency changes, and injected failures at every preparation
  phase. Exclude process crash; restart recovery is a separate property.
- **Preconditions:** desired registry snapshots themselves pass native
  structural validation, except explicit invalid-input commands.
- **Oracle:** a pure graph model applies only fully valid candidates and retains
  last-good state otherwise. It does not import Cordis or production planner
  code.
- **Failure value:** a failed replacement removes the active old plugin.
- **Tier:** pull request and scheduled extended histories.
- **Initial status/test ID:** proposed / `architecture.live-reconcile.property`.

### PROP-F-ATOMIC-001

- **Claim:** Every observer of generated publication interleavings sees either
  the complete old service-and-catalog family or the complete new family and
  never a mixture.
- **Shape:** safety.
- **Evidence:** SEM-F-002, SEM-F-003.
- **Domain:** generated service, command, menu, navigation, view, settings, and
  message contribution sets with observer reads around publication yield
  points. Exclude browser rendering after snapshot delivery.
- **Preconditions:** both candidate service graphs and catalogs are internally
  valid.
- **Oracle:** each observed family digest must equal the retained old or new
  canonical digest.
- **Failure value:** a new menu command becomes clickable before its command
  handler is routed.
- **Tier:** pull request.
- **Initial status/test ID:** proposed / `architecture.catalog-atomicity.property`.

### PROP-F-REVISION-001

- **Claim:** For every generated out-of-order notification sequence, the
  applied revision is monotonic and converges to the highest successfully
  observed desired revision.
- **Shape:** monotonicity.
- **Evidence:** SEM-F-001, SEM-F-005.
- **Domain:** duplicate, delayed, skipped, and reordered revision notifications
  with snapshot rereads. Exclude permanent loss of registry access.
- **Preconditions:** revision values are valid native registry revisions.
- **Oracle:** an independent maximum-successful-revision model.
- **Failure value:** a delayed event rolls the browser back to an older plugin
  graph.
- **Tier:** pull request.
- **Initial status/test ID:** proposed / `architecture.runtime-revision.property`.

### PROP-F-CONTINUITY-001

- **Claim:** Replacing or removing any generated presentation plugin changes
  only its activation-owned leases and leaves host-owned terminal session
  identities and processes unchanged.
- **Shape:** conservation.
- **Evidence:** SEM-F-006, SEM-F-007.
- **Domain:** active raw and semantic terminal sessions, zero or more
  attachments, replacement failures, successful replacement, disable, and
  removal. Exclude the explicit terminal stop operation and external process
  exit.
- **Preconditions:** the terminal host remains healthy.
- **Oracle:** compare an independent host-resource ledger before and after each
  reconcile command.
- **Failure value:** changing terminal presentation kills or re-IDs a running
  CLI session.
- **Tier:** release, with a fake-host form in pull requests.
- **Initial status/test ID:** proposed / `architecture.terminal-plugin-continuity.property`.

### PROP-F-INSPECTION-001

- **Claim:** Every live or failed generated activation has exactly one
  inspection record whose owner links resolve to its artifact, desired
  revision, grants, contributions, effects, diagnostics, and leases.
- **Shape:** conservation.
- **Evidence:** SEM-F-008.
- **Domain:** generated successful, failed, replaced, draining, and disposed
  activations. Exclude redacted private payload values.
- **Preconditions:** inspection snapshot corresponds to a settled runtime
  transition.
- **Oracle:** the command model retains each entity and reference, then checks
  referential completeness of the emitted snapshot.
- **Failure value:** an agent sees a broken view or failed headless service but
  cannot identify its plugin activation or failure record.
- **Tier:** pull request.
- **Initial status/test ID:** proposed / `architecture.runtime-inspection.property`.

### PROP-F-SERVICE-001

- **Claim:** For every generated provider add, replace, failure, disable, and
  remove history, every settled consumer call routes to exactly the provider in
  the accepted graph or returns the specified unavailable result; it never
  reaches a provisional or disposed provider.
- **Shape:** state-machine and safety.
- **Evidence:** SEM-F-002, SEM-F-003, SEM-F-006, SEM-F-009.
- **Domain:** compatible and incompatible provider versions, multiple
  consumers, readiness failure, calls around publication points, and provider
  disposal. Exclude in-flight drain policy until its service contract defines
  that policy.
- **Preconditions:** calls have stable service and consumer activation IDs.
- **Oracle:** an independent routing ledger records accepted provider identity
  at each publication boundary and validates every observed call target.
- **Failure value:** a consumer calls the old service after replacement disposal
  or observes the candidate before atomic publication.
- **Tier:** pull request and scheduled extended histories.
- **Initial status/test ID:** proposed / `architecture.service-reconcile.property`.

### PROP-F-RESTART-001

- **Claim:** Restart reconstruction converges to the same accepted graph and
  inspection identities as live reconciliation from the same durable desired
  snapshot.
- **Shape:** differential.
- **Evidence:** SEM-F-001, SEM-F-004, SEM-F-008.
- **Domain:** durable registries with accepted, disabled, rejected, replaced,
  and dependency-ordered artifacts plus prior failure diagnostics.
- **Preconditions:** native artifact admission and registry data remain
  available.
- **Oracle:** compare normalized cold-start and live-reconcile snapshots from
  separate fresh supervisors. Activation instance IDs are normalized.
- **Failure value:** restart activates a disabled plugin or forgets the
  last-good provider.
- **Tier:** pull request and release.
- **Initial status/test ID:** proposed / `architecture.runtime-restart.property`.

Live state is not a substitute for durable desired state. Host-owned terminals
are re-attached by identity rather than recreated.

## Exit proof

- fixture plugin add, replace, invalid replace, disable, and remove work without
  webview reload;
- headless service-provider replacement preserves consumer routing and disposes
  the old provider cleanly;
- last-good and atomic catalog properties pass;
- no effect remains after disposal;
- desired and applied revisions are visible in CLI JSON;
- terminal continuity passes in a packaged app;
- static built-ins may remain for features not yet migrated, but they are
  explicitly marked compatibility activations.

## Deletion gate

Delete restart-bound-only browser startup logic after the live supervisor can
reconstruct the same graph at startup and after revision change. Keep native
artifact admission and durable registry; they are permanent authorities.
