# CLI and module integration

## CLI surface

Add a Clap `schedule` command group:

```text
shipctl schedule list --instance <name>
shipctl schedule inspect <id> --instance <name>
shipctl schedule diagnose --instance <name>
shipctl schedule verify --instance <name>
shipctl schedule refresh --instance <name>
shipctl schedule refresh --all-instances
shipctl schedule trigger <id> --instance <name>
```

All single-instance commands require an explicit instance name. `refresh
--all-instances` is a deliberate fan-out: it calls each running instance
independently and returns a result for each. It does not claim a cross-process
transaction and does not touch stopped instances.

Default output is concise and machine-readable, with stable codes and totals.
JSON remains available for exact assertions. `--full` may expand non-secret
diagnostics but never reveals secret-marked payload fields.

## Running-instance protocol

Extend the existing same-user local control protocol with versioned schedule
requests and responses. Reuse instance discovery, endpoint authentication,
frame validation, and streaming completion. Do not expose an HTTP or REST port.

Refresh and trigger are explicit mutations with request identity so a client
can retry after a lost response without applying a second refresh or duplicate
manual trigger. Inspection and verification are read-only.

`refresh` and `trigger` accept an optional `--request-id <UUID>`; reusing it
replays the original redacted result for the same command during that running
instance incarnation. A request ID reused for a different scheduler command is
rejected. The replay ledger is instance-local memory only and ends with the
host process; it is not schedule state or an execution journal.

The response identifies instance name and incarnation, schedule generation,
source digest, bus route generation, operation outcome, and diagnostics.

## Module contract

Modules do not receive timer callbacks or a generic scheduler service. They
declare typed message handlers or subscriptions through
`@shipctl/module-api`; schedules address those declared endpoints.

A module may ship example schedule files as assets, but installation does not
silently copy or enable them. Humans or agents explicitly place schedule files
in the instance's schedule root and refresh that instance.

When a module is disabled, replaced, or removed, its routes disappear. Existing
schedules remain source configuration but report target-unavailable status.
Re-enabling a compatible endpoint lets the scheduler reconcile without editing
the schedule file.

## Manual trigger

`trigger` looks up one accepted schedule, validates its current route and grant,
and performs the same bus send or publish used by the timer. It does not modify
the next occurrence or write an execution record. Disabled schedules can be
inspected and verified but not triggered.

This command is the fast integration seam for agents: install a module, refresh
its schedule, trigger it, inspect the handler's observable result, and remove
the module in one compiled running instance.

## Existing-code migration

- Replace `ModuleTaskSchedule` and `ModuleScheduledTask` in
  `modules/api/frontend/src/module.ts` after the native scheduler is proven.
- Remove `setTimeout` and `setInterval` schedule ownership from
  `core/frontend/host/moduleComposition.ts`.
- Migrate the usage module's browser-scheduled refresh to a message handler and
  an optional schedule source.
- Keep UI-only animation and interaction timers local; they are not scheduler
  jobs.
