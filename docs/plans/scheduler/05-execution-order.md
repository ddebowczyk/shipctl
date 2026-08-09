# Execution order

## S1 — freeze file and inspection contracts

Implement `ShipctlPaths::schedule_root`, strict YAML types, normalized
inspection types, diagnostics, canonical digests, and shared goldens. Add
message-bus references but no timers.

**Exit:** fixtures prove path safety, strict parsing, schema compatibility,
timezone requirements, and cross-language wire agreement.

## S2 — implement candidate loading and atomic refresh

Build the complete-directory loader, bus-route preflight, snapshot generation,
and in-memory publication. Integrate startup loading and degraded diagnostics.

**Exit:** valid snapshots apply atomically; any invalid candidate preserves the
previous generation and task definitions.

## S3 — implement the instance runtime

Add cancellable Tokio job loops, next-occurrence calculation with `cronexpr`,
bus delivery, manual trigger internals, in-memory observations, and shutdown.

**Exit:** paused-time tests prove delivery, refresh cancellation, missed-time
policy, target failures, instance isolation, and zero durable writes per tick.

## S4 — add control protocol and CLI

Implement list, inspect, diagnose, verify, refresh, explicit all-instance
refresh, and trigger through the existing local endpoint. Keep command parsing
in Clap and command output agent-safe.

**Exit:** a separately running instance can be verified, refreshed, triggered,
and diagnosed by `shipctl`; retries do not duplicate mutations.

## S5 — migrate browser scheduling and prove live operation

Migrate the usage module as the first real consumer. Remove host ownership of
`ModuleScheduledTask` and browser `setTimeout`/`setInterval` scheduling after
parity is proven. Add focused and full-application verification.

**Exit:** the once-built packaged host applies file changes and module route
changes live, two instances stay isolated, the UI does not reload, and state
digests prove there is no event or tick persistence.

## Work ordering with the message bus

- S1 can follow message-bus M1.
- S2 and S3 require message-bus M2.
- S4 requires the running-instance protocol and message inspection shape from
  M5.
- S5 requires supervisor route reconciliation from M4.

Do not start the browser-scheduler removal before its replacement passes the
packaged trigger and refresh proof.
