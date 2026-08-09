# Instance scheduler

## Goal

Give each running Shipctl instance a file-defined scheduler that sends typed
messages at calendar times. Humans and agents can add, edit, disable, inspect,
verify, and refresh schedules without rebuilding or reloading Shipctl.

The scheduler does not run shell commands or filesystem scripts. It is a
temporal producer for the instance-local message bus.

## Required outcomes

- One complete schedule is stored in each YAML file.
- Multiple schedule files form one atomic snapshot for a named instance.
- Each instance reads schedules from its own configurable state root.
- `shipctl schedule refresh --instance <name>` applies file changes live.
- `--all-instances` is explicit and reports an independent result per instance.
- Invalid refresh leaves the last accepted snapshot and jobs running.
- Scheduled delivery uses typed, authorized bus channels or topics only.
- Agents can list, inspect, diagnose, verify, refresh, and trigger schedules.
- Timer firing and message delivery do not create an event journal or routine
  database writes.
- Tests use one compiled host and deterministic time where possible.

## Documents

1. [Schedule file contract](./01-schedule-file-contract.md)
2. [Rust runtime and refresh](./02-rust-runtime-and-refresh.md)
3. [CLI and module integration](./03-cli-and-module-integration.md)
4. [Inspection and verification](./04-inspection-and-verification.md)
5. [Execution order](./05-execution-order.md)

## Boundary decisions

- Schedules target only the current named instance.
- Startup performs an initial load; subsequent filesystem edits require an
  explicit refresh. There is no filesystem watcher.
- A scheduled occurrence makes one delivery attempt. The receiver owns retry
  or durable workflow policy.
- Restart and sleep do not replay missed occurrences. The scheduler computes
  the next future occurrence.
- A manual trigger exercises the same validation and delivery path without
  changing the next scheduled time.
- Schedule definitions are configuration sources, not operation-journal rows.

Use Tokio's cancellable
[`sleep_until`](https://docs.rs/tokio/latest/tokio/time/fn.sleep_until.html) for
runtime waiting and `cronexpr` for timezone-aware calendar calculation. The
[`cronexpr` documentation](https://docs.rs/cronexpr/latest/cronexpr/) describes
its cron grammar and explicit IANA timezone support.

## Dependency

This plan depends on the message bus contracts and Rust runtime. Scheduler
files may address module-defined endpoints, so new capabilities do not require
new scheduler code.
