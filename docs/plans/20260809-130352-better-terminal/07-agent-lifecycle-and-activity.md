# Explicit agent lifecycle and terminal activity

## Objective

Add explicit, revisioned agent lifecycle reports after stable terminal identity,
host registry, control socket, renderer reconciliation, and module adoption are
working. Reports improve UI attention and automation but remain supplemental to
authoritative terminal process lifecycle.

This slice must not be used to compensate for missing PTY exit handling,
subscriber state, or renderer reconciliation.

## State model

Keep process lifecycle and agent activity as different fields:

```text
terminal.lifecycle = starting | running | closing | exited
terminal.exit      = host-observed child result

agent.state        = unknown | idle | working | blocked
agent.attention    = optional blocked/completed event
agent.revision     = host-assigned monotonic revision
agent.updated_at   = host observation timestamp
agent.source       = reporting integration identity
```

`completed` is an attention/report event, not proof that the child exited. An
agent may report completed and remain at a shell prompt. `blocked` may be both a
state and attention event. Process exit does not invent an agent-completed
report.

Do not add a guessed stale timeout. If product requirements later need stale
classification, they must define the acceptance rule and source clock. Until
then, the UI shows the latest explicit report with its timestamp/source and the
independent host lifecycle.

## Host-owned report contract

Add domain types to terminal descriptors and events:

```rust
enum AgentReportKind { Idle, Working, Blocked, Completed }

struct AgentReportRequest {
    terminal_id: TerminalId,
    kind: AgentReportKind,
    source: AgentReportSource,
    message: Option<String>,
}

struct AgentActivity {
    state: AgentState,
    revision: u64,
    updated_at: ...,
    source: AgentReportSource,
    attention: Option<AgentAttention>,
}
```

The host assigns revision and observation time when it accepts a report. A
caller-supplied occurrence time, if needed for diagnostics, is separate and
cannot control ordering. This prevents clock skew and replayed lower revisions
from overwriting current state.

Constrain `source` to a safe identifier/version pair. Constrain optional message
size from the existing control frame and descriptor limits; document the
derivation. Messages are public UI metadata and must not carry prompts, full
transcripts, or credentials.

Report transitions:

- `idle`: state becomes idle, prior attention remains acknowledged/cleared
  according to one documented UI rule;
- `working`: state becomes working and does not imply output;
- `blocked`: state becomes blocked and creates blocked attention at the new
  revision;
- `completed`: creates completed attention and normally returns state to idle;
  it does not close the terminal.

Choose the exact attention-clear rule in code and fixtures before UI work. Keep
it deterministic and event-driven; do not clear based on elapsed time.

## Environment and CLI

The runtime/registry slice injects `SHIPCTL_TERMINAL_ID` and
`SHIPCTL_INSTANCE_ID` into every terminal. Use those for low-friction reports:

```text
shipctl terminals report working
shipctl terminals report blocked --message "waiting for review"
shipctl terminals report completed
shipctl terminals report idle
```

`--terminal-id` explicitly overrides the environment for integrations running
outside the terminal. If neither is available, return a structured usage error
that tells the caller to pass the ID. Validate that the target belongs to the
selected/current instance.

The report operation travels through the same authenticated instance control
socket as terminal list/get/write/close. It returns the accepted activity state
using normal finite TOON/JSON output and writes no progress prose to stdout.

Do not ask integrations to call Tauri IPC or mutate renderer stores.

## Service behavior

`TerminalService::report_agent`:

1. finds the record by stable ID under the registry lock and clones the handle;
2. releases the registry lock;
3. validates lifecycle and report payload;
4. updates agent state/revision under the record's small state lock;
5. emits a descriptor/agent event to lightweight registry listeners and active
   terminal attachments;
6. returns the authoritative updated state.

Accept reports for running terminals. Define explicit behavior for a report
racing exit:

- if exit committed first, reject with `terminal_exited` and leave final
  activity unchanged;
- if report committed first, publish it before the later exit event.

This is ordering, not wall-clock guesswork.

Retained exited descriptors preserve the last accepted activity and attention
for inspection until explicit close.

## Integration ownership

Core provides the report contract and display state. Each agent/provider module
owns how its integration emits reports.

Examples of valid integration points:

- a provider hook calls `shipctl terminals report working` before a turn;
- a completion hook reports completed;
- a permission/review hook reports blocked;
- a module that already has authoritative session events reports through the
  shared terminal service/control client.

Do not hard-code one provider's hook layout into core terminal code. Do not
parse arbitrary terminal prose to synthesize explicit reports.

Roll out integrations independently. Each integration needs a fixture proving
that it inherits the correct terminal/instance environment and that failures to
report do not break the agent command.

## Renderer activity projection

Add `agentActivity` to `TerminalDescriptor` and terminal registry events. The
frontend reconciliation reducer merges it by record/report revision.

UI rules:

- running/exited presentation comes from `terminal.lifecycle`;
- idle/working/blocked/completed attention comes from `agentActivity`;
- show source/timestamp in detailed inspection where useful;
- attention clears through an explicit user/view acknowledgement action or a
  later report according to the chosen state contract;
- renderer reload reconstructs the same activity from the host descriptor;
- a stale event from an old attachment/record revision is ignored.

Retire `usePty.ts`'s module-level activity timer maps. If output-based activity
is kept as a fallback for integrations that do not report, name it
`outputActivity` and display it as lower-confidence presentation data. It must
not overwrite explicit blocked/completed state and must use the existing
behavior rather than a newly invented timeout.

Once supported integrations report reliably and product acceptance confirms
the fallback is no longer needed, remove the timer-based heuristic in a
separate explicit cleanup change.

## Module adoption

Agent activity belongs to the terminal descriptor, so module adoption receives
it automatically. Modules may mirror it into their own business records but
must not become the authority.

On renderer reload:

- the host descriptor contains latest activity;
- core projects it into the terminal view;
- the owning module receives the same adopted/updated snapshot;
- duplicate projection does not increment activity revision or create duplicate
  attention.

Explicit module session status and terminal agent activity may coexist. Define
mapping in the owning module; do not make core assume they are identical.

## Control and protocol changes

Extend the terminal control operation family with `Report`. If the terminal
operation family was introduced in the prior slice with a reserved/report
variant already in schema, implement it now; otherwise bump the exact control
protocol/frame version according to repository policy.

Add report/activity fields additively only if current exact-version rules allow
it. Update:

- Rust protocol DTOs and serialization tests;
- CLI args/completions/output goldens;
- TypeScript terminal descriptor/event types;
- Tauri registry event DTOs;
- module shared snapshot types.

## Tests

### Service tests

- Idle/working/blocked/completed transitions produce deterministic state and
  monotonically increasing revisions.
- Completed does not close or mark the child exited.
- Report/exit races publish one valid order.
- Exited terminal rejects new reports and preserves last accepted state.
- Retried duplicate CLI invocations create new host revisions only when they
  are accepted as new reports; if idempotency keys are added, prove their
  explicit contract rather than guessing duplicates.
- Registry lock is not held while report events are delivered.

### CLI/control tests

- Environment default resolves `SHIPCTL_TERMINAL_ID` and instance correctly.
- Explicit ID override works and cross-instance ID is rejected.
- Missing/invalid environment returns a structured error.
- Finite TOON/JSON output contains ID, state, revision, source, and timestamp.
- Message validation rejects oversized/invalid data without leaking it to logs.

### Renderer tests

- Explicit working/blocked/completed survives reconciliation and renderer
  reload.
- Lifecycle exit remains distinct from completed.
- Old activity revisions are ignored.
- Attention acknowledgement follows the chosen deterministic rule.
- Output fallback cannot override explicit blocked/completed.

### Integration tests

- Each supported agent integration reports through the injected environment.
- Reporting failure is non-fatal to the agent command unless that integration's
  existing contract explicitly requires it.
- Core remains provider-neutral and module boundary checks pass.

## Acceptance criteria

This slice is complete when:

- report state is host-owned, revisioned, and distinct from process lifecycle;
- the CLI reports through the existing authenticated control socket and
  injected terminal identity;
- descriptors, registry events, attachments, renderer, and module adoption all
  carry the same activity state;
- blocked/completed attention survives renderer reload;
- no provider-specific hook behavior lives in core terminal code;
- old renderer-global activity maps are removed or explicitly retained only as
  a lower-confidence compatibility fallback;
- no guessed stale timeout or output-to-lifecycle inference is introduced.

## Files expected to change

- `core/backend/src/terminal/types.rs`
- `core/backend/src/terminal/service.rs` and record/event code
- `core/backend/src/instance/protocol.rs`
- `cli/src/args.rs` and terminal dispatch/output tests
- `core/frontend/platform/types.ts`
- terminal reconciliation/store/view activity code
- `modules/api/frontend/src/services.ts`
- owning agent module integrations and tests
