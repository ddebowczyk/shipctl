# Inter-module information flow decision

Date: 2026-08-07

## Decision

Do not add an inter-module capability runtime yet.

The completed Usage and Assistants extractions expose no concrete
provider-consumer relationship. Usage snapshots are read only by Usage-owned
surfaces and stores. The former candidate consumer, the Assistants model
picker, now discovers models through Assistants-owned provider catalogue probes
and no longer needs Usage's observed-model data.

Adding a token registry, provider subscription API, or global event bus without
a consumer would violate the migration rule that extension points follow an
observed capability need. The smallest justified shared contract is therefore
the existing `@shep/module-api` surface, unchanged.

## Concrete flow inventory

- Usage produces provider quota and local token/cost snapshots. Only the Usage
  frontend consumes them, through namespaced Tauri commands inside
  `shep.usage`.
- Usage emits ingestion completion. Only the Usage frontend consumes it,
  through the module-internal `usage-ingest-complete` event.
- Assistants produces provider model catalogues. Only the Assistant launcher
  consumes them, through a namespaced Tauri command inside `shep.assistants`.

No module imports `@shep/module-usage` except the host composition root. The
module-boundary check rejects sibling-module imports, and the Usage plug-out
matrix proves that removing Usage leaves Assistants and the host buildable.

## Options considered

### Explicit composition-root injection

This is the preferred first implementation when a real consumer appears. The
composition root can wire a narrow typed provider into the consumer's public
factory or activation input. That makes the dependency visible at build time,
supports an explicit absent-provider value, and avoids a global lookup API.

The tradeoff is deliberate composition knowledge: the profile must name both
participants. That is appropriate for one concrete relationship and keeps the
shared API free of feature DTOs.

### Typed capability tokens

A registry keyed by typed tokens could support current-value reads plus
subscriptions, duplicate-provider validation, and cleanup. It becomes
justified when at least two independent relationships show that composition
injection is repeating the same lifecycle machinery.

Introducing it now would create a service locator with no production caller.
It would also force a premature choice about contract ownership, versioning,
snapshot identity, freshness, and error semantics.

### Global event bus

A stringly typed dispatch/listen API is rejected. It hides dependencies, has no
intrinsic current value for late subscribers, makes provider absence ambiguous,
and shifts contract failures to runtime. The existing
`usage-ingest-complete` event remains private to the Usage module; it is not an
inter-module API.

## Future entry criteria

Reopen this decision only when a named module needs information owned by a
different removable module and its minimum data and freshness semantics are
known. The first implementation must then prove:

1. the consumer has a useful provider-absent state;
2. a current snapshot is available before update subscription, avoiding a lost
   startup event;
3. subscription teardown runs during module deactivation;
4. duplicate providers fail during composition;
5. the dependency is visible in the profile or package manifests; and
6. provider-disabled, consumer-disabled, and source-absent builds pass.

Until those criteria are met, module-internal query/subscription mechanisms stay
inside their owning module and sibling imports remain forbidden.

## Verification

The decision is supported by:

```sh
pnpm test:module-boundaries
pnpm test:module-composition
pnpm test:assistant-providers-characterization
pnpm test:usage-characterization
pnpm verify:usage-plugout
```

The final command covers enabled, disabled, and physically source-absent Usage
profiles. No new shared runtime or untyped dispatch/listen API is introduced.
