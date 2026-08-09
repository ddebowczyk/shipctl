# Inspection and verification

## Agent inspection

Extend the running-instance control protocol and Clap CLI with:

- `shipctl messages inspect --instance <name>`;
- `shipctl messages diagnose --instance <name>`.

Inspection returns contract IDs and versions, active route generation, channel
owners, subscriber counts, effective grants, queue state, activation identity,
and redacted current diagnostics. Module inspection joins the same information
to the module that owns or consumes each endpoint.

Do not expose message payload history. Do not add a generic CLI send or publish
command in this work: arbitrary injection would bypass capability-specific
authorization. Agent actions use the relevant capability port; the scheduler
is an explicitly authorized core sender.

Default agent output remains concise and machine-readable, with JSON available
for exact integration assertions. Human hints go to stderr and never corrupt
structured stdout.

## Verification commands

Add focused repository operations under `ops/message-bus/` and expose them as:

- `just message-bus contract`;
- `just message-bus integration`;
- `just message-bus all`.

Each command emits structured evidence with the running instance name,
incarnation, host binary digest, route generations, fixture artifact digests,
assertions, and stable failure codes.

## Contract tests

- Rust round-trips every public envelope and receipt golden.
- TypeScript consumes the exact Rust goldens.
- Unknown fields, incompatible versions, invalid identifiers, invalid schemas,
  oversized payloads, and secret leakage fail with stable codes.
- Schema references cannot escape the artifact or access the network.
- Module-defined capability contracts pass without a host rebuild.

## Runtime tests

- Directed messages preserve acceptance order on one channel.
- Bounded queues apply backpressure instead of silently dropping.
- Broadcast reaches current subscribers and reports lag deterministically.
- One failing handler does not terminate the bus or another handler.
- Unauthorized, unknown, and withdrawn endpoints fail closed.
- Request/reply cancellation releases the reply handle.
- Route publication never exposes a mixed snapshot, and a route-generation
  conflict leaves the accepted snapshot unchanged.
- Existing or withdrawn registrations retain inspectable bridge and runtime
  lease observations.
- Webview bridge replacement does not change backend route ownership.
- Two named instances sharing a state root cannot exchange runtime messages.
- Sending and handling leave registry and state-source file digests unchanged.

## Packaged proof

Build the host once. Selected runtime and bridge cases exercise active fixture
registrations for typed delivery, authorization rejection, bounded behavior,
and bridge closure and reopening. The public running-instance boundary launches
two named instances and exercises inspection and diagnosis; it intentionally
has no arbitrary send or publish command. Assert that named instances are
isolated and that routine bus activity leaves the sorted raw digests of every
included durable-state archive entry unchanged under an isolated profile. The
proof records redacted evidence only; it does not invoke module enable,
replace, disable, re-enable, or remove operations.

The packaged A/B/C lifecycle matrix, including failed-C preservation and
generic add/replace/disable/re-enable/remove operations, belongs to
`shep-btu.10` Phase 4 and `shep-btu.11` Phase 5.

The proof records the host binary digest before and after the run. Equality is
the assertion that runtime changes did not rebuild Rust or Tauri.
