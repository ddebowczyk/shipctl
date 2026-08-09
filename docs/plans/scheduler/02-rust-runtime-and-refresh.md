# Rust runtime and refresh

## Placement

Add one backend capability at `core/backend/src/scheduler/`:

- `contracts.rs` — strict file and inspection types;
- `loader.rs` — discovery, parsing, validation, and snapshot digest;
- `runtime.rs` — job ownership, deadlines, refresh, and shutdown;
- `diagnostics.rs` — stable redacted diagnostic codes;
- `commands.rs` — thin Tauri wrappers;
- `mod.rs` — narrow public exports.

`src-tauri/src/lib.rs` constructs the service with `InstanceContext`,
`ShipctlPaths`, and the instance's `RuntimeMessageBus`. It contains no schedule
parsing or timer behavior.

## Atomic refresh

Refresh is a complete directory reconciliation:

1. Enumerate eligible files and read them without mutating active state.
2. Parse strictly and validate the complete set.
3. Resolve message contracts and scheduler grants against one route snapshot.
4. Calculate each enabled schedule's next future occurrence.
5. Build a canonical snapshot and digest.
6. Publish it through a Tokio `watch` channel in one step.
7. Reconcile job tasks to the new generation.

Any failure before publication returns per-file diagnostics and preserves the
previous snapshot and tasks. An empty valid directory publishes an empty
snapshot and cancels all former jobs.

Concurrent refresh requests use the instance control path and serialize at the
scheduler service. A refresh prepared against an obsolete bus route generation
must revalidate before publication or fail without partial application.

## Job loop

Each enabled schedule is owned by the service, not by a module or React
component. The loop waits on:

- Tokio `sleep_until` for the next occurrence;
- `watch` change for a new schedule snapshot;
- route change that invalidates its target;
- instance shutdown cancellation.

At a due time, recompute the occurrence from wall-clock time, deliver through
the bus using the scheduler's bound identity, record an in-memory redacted
observation, and calculate the next future occurrence. A refresh or shutdown
cancels the old wait immediately.

After process restart, machine sleep, or a backward clock correction, compute
the next future occurrence. Do not replay missed times or fire a catch-up burst.
A target outage produces a diagnostic for that occurrence; the next occurrence
remains scheduled. There is no scheduler-level retry.

## Startup and degraded state

Load schedules during instance service initialization. Invalid files do not
prevent the UI or control endpoint from starting. With no previous in-memory
snapshot, the scheduler starts with an empty active snapshot and reports a
degraded diagnostic containing file provenance and stable codes.

This makes `shipctl schedule diagnose --instance <name>` available to repair a
bad configuration rather than stranding the instance.

## State kept in memory

Keep only current operational observations:

- accepted snapshot generation and digest;
- source path and definition digest per schedule;
- enabled state, target, and next occurrence;
- last attempted occurrence and delivery receipt summary;
- current redacted diagnostic;
- runtime task state and cancellation status.

Do not store tick events, payloads, or delivery history in SQLite. A logger or
observability module may subscribe to explicitly published application topics
if an operator chooses to retain them.
