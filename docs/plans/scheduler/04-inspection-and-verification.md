# Inspection and verification

## Inspection model

`list` and `inspect` report the accepted schedule snapshot, not merely files
currently present on disk. They show source provenance and digests so an agent
can detect unapplied edits.

For each schedule expose:

- ID, enabled state, schema version, and definition digest;
- source path relative to the schedule root;
- target endpoint and message contract version;
- accepted schedule and bus route generations;
- next occurrence in UTC and configured timezone;
- last attempted occurrence and redacted delivery outcome;
- target availability and current diagnostic.

`verify` parses the current directory into a candidate snapshot and compares it
with active state without publishing it. `diagnose` adds service, target, and
runtime health. Neither command mutates timers.

## Verification commands

Add focused operations under `ops/scheduler/` and expose:

- `just scheduler contract`;
- `just scheduler integration`;
- `just scheduler all`.

Evidence includes instance name and incarnation, host binary digest, source and
accepted snapshot digests, scheduler and bus generations, deterministic clock
inputs, delivery receipts, assertions, and stable diagnostics.

## Contract and loader tests

- Rust accepts every valid YAML fixture and rejects each invalid fixture with
  the specified code and source location.
- TypeScript consumes the exact normalized Rust inspection goldens.
- Directory order cannot alter the snapshot digest.
- Duplicate IDs and one invalid file reject the complete candidate.
- Failed refresh leaves the previous accepted digest and jobs unchanged.
- Empty valid directory disables all schedules atomically.
- Symlinks and paths outside `schedule_root` fail closed.

## Deterministic runtime tests

Use Tokio's documented
[`pause`](https://docs.rs/tokio/latest/tokio/time/fn.pause.html) and
[`advance`](https://docs.rs/tokio/latest/tokio/time/fn.advance.html) test
utilities rather than real sleeps.

- A due channel schedule sends exactly one accepted message.
- A due topic schedule publishes to current subscribers.
- Refresh cancels the old deadline and installs the new one.
- Manual trigger uses the same path and leaves the next deadline unchanged.
- Disabled schedules never deliver.
- Missing, withdrawn, or incompatible targets produce inspectable failures.
- Subscriber or handler failure cannot terminate another job.
- DST transitions and clock movement compute the next future occurrence.
- Restart and suspended time do not replay missed occurrences.
- Two named instances cannot trigger or refresh each other's schedules.

## SSD-write proof

In deterministic tests, record digests and metadata for the module registry,
schedule sources, and other durable state before advancing through multiple
occurrences. Assert those files are unchanged afterward. Repeat with manual
trigger. This proves the scheduler has no per-tick persistence path without
inventing a write-rate threshold.

## Packaged proof

Build once and launch two named instances with distinct state roots. Give each
different schedule files targeting the same module contract. Refresh and
trigger each instance, then change, disable, and remove definitions while the
hosts remain running. Prove independent generations, correct delivery,
unchanged host binary digests, no webview reload, and no durable event writes.
