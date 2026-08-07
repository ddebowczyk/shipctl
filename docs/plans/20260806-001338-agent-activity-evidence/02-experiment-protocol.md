# Experiment protocol and fixtures

## Safety and isolation

Run these experiments only after approval to start test Claude/Codex sessions.
They use the user's existing CLI authentication and may consume normal CLI
quota, but they must not call an SDK or provider API.

Before each provider run:

1. Create a disposable empty Git directory with no credentials or user source.
2. Record CLI name, version, launch arguments class, terminal dimensions, theme,
   macOS version, and a configuration fingerprint. Do not store auth material.
3. Give the run a random `run_id`; never infer identity from a PID alone.
4. Create a private run directory under a dedicated local lab root, with
   user-only permissions and a documented retention period.
5. End the CLI normally where possible; use an explicit stop test only in its
   own run.

The experiment runner is separate from Shep production code at first. It writes
data that can be inspected and deleted without affecting session restoration,
the user configuration, or real projects.

## Common fixture matrix

Every provider should run each supported scenario at least ten times across two
terminal sizes and two themes. Mark unavailable capabilities as `not supported`,
not failed.

| Scenario | Safe fixture | Ground-truth label | Primary purpose |
| --- | --- | --- | --- |
| launch and quiet prompt | Start CLI; wait 60 seconds without a prompt | `process_live`, `unobserved_quiet` | Baseline liveness and idle screen |
| short answer | Ask for a one-word response only | provider turn boundary | Output/turn timing |
| model-only deliberation | Ask for a read-only explanation of a small static fixture | provider turn open, then stop | Quiet remote-work counterexamples |
| local long tool | Ask to run `sleep 30` then report completion | tool in flight | Descendant and CPU behavior |
| tool failure | Ask to run a harmless command that exits non-zero | tool failure | Completion/failure correlation |
| attention or permission | Request a harmless action under normal permission mode | needs attention | Hook and terminal attention evidence |
| interruption | Send the normal interactive interrupt, then exit | interrupted turn/root outcome | State cleanup |
| resize and redraw | Resize while a response or tool is active | unchanged lifecycle | PTY pattern robustness |
| subagent or team | Ask for two read-only delegated analyses when available | child lifecycle | Optional subagent coverage |

The test prompt text belongs in fixture files, not in the telemetry schema. A
run may save it only because the test directory is disposable and non-secret;
production telemetry may not save it.

## Experiment A: process observation

### Process-observation procedure

1. Launch one managed test session through the same `spawn_pty` path used by
   Shep.
2. At 2 Hz, collect a root/descendant snapshot. Repeat at 5 Hz for the overhead
   run and at the intended production rate for the accuracy run.
3. For every discovered process, retain its PID plus start identity; sample
   `pid`, `ppid`, `pgid`, process state, elapsed time, CPU, and RSS.
4. Label transitions from the scenario control log and, where available, a hook
   event. Do not label from the sampler being evaluated.
5. Repeat with a child that starts a new session/process group, if the CLI or
   deliberate fixture does so.
6. Measure observer CPU, wake-ups, and latency across one, five, and twenty
   idle test roots.

### Process-observation expected findings

- Root liveness and exit should be highly reliable.
- A local `sleep`/shell phase should reveal an active descendant.
- Remote waiting, model computation, and some streaming phases can remain a
  live root with no useful CPU/RSS or child change.
- PID reuse and detached children are implementation hazards; process start
  identity and periodic reconciliation are mandatory if process data ships.

### Data to keep

`os-samples.ndjson` has one redacted snapshot per sample; `timeline.ndjson`
contains scenario labels and bridge/PTY markers. Record an executable basename,
not a full arbitrary command line. Delete raw process data after evaluation.

## Experiment B: hook bridge

### Hook-bridge procedure

1. Inspect the installed provider documentation and current configuration
   before changing anything. Do not inject dynamic hook configuration through
   a launch flag or overwrite a user hook collection.
2. With explicit approval, add a documented, test-scoped hook that invokes a
   tiny bridge emitter. Preserve a configuration backup and remove the test
   configuration immediately after the run.
3. The emitter reads JSON from stdin, keeps only allowlisted fields, attaches
   `run_id`/nonce, and sends one event to a user-only Unix domain socket.
4. The receiver timestamps, validates, deduplicates, and writes the normalized
   event to `hook-events.ndjson`. It acknowledges nothing that would delay the
   hook command.
5. Exercise session start/end, prompt, pre/post/failure tool, permission,
   notification, subagent start/stop, task creation/completion, and stop events
   when each provider/version supports them.
6. Repeat with the socket absent, the receiver restarted, and deliberately
   duplicated messages. Record drops as explicit bridge health events.

### Required bridge contract

```json
{
  "schema_version": 1,
  "run_id": "opaque-test-id",
  "provider": "claude|codex",
  "event_name": "provider-native-name",
  "observed_at_monotonic_ns": 0,
  "session_id": "opaque-or-hashed",
  "agent_id": "opaque-or-hashed",
  "tool_class": "Bash|Edit|Write|other",
  "sequence": 1
}
```

The bridge must omit prompt text, tool arguments, tool responses, file content,
environment values, and provider credentials. The receiver must reject events
without the current run nonce or outside its private socket directory.

### Hook-bridge expected findings

Hooks should provide the only high-confidence answer to questions such as
“which tool is in flight?” and “is the agent waiting for permission?” They may
not report remote/internal provider activity between callbacks; absence of an
event remains `unobserved_quiet`.

## Experiment C: PTY and terminal-protocol recording

### PTY-recording procedure

1. Add an observer at the existing Rust-to-frontend channel boundary. It must
   copy bytes and timestamps before xterm rendering without modifying, delaying,
   or redacting the displayed stream.
2. Record raw bytes only in the non-secret fixture, together with chunk size and
   monotonic timestamp. Protect the capture directory and delete it after
   analysis.
3. Decode ANSI/OSC/BEL into a second derived stream. First extract only generic
   facts: byte arrival, BEL, OSC notification/title/cwd when present, alternate
   screen use, and cursor/screen redraw volume.
4. Compare the derived stream to hook labels, process snapshots, screenshots,
   and manually marked prompt/attention moments.
5. Re-run after resize, theme changes, a session resume, and an installed CLI
   upgrade if available.

### Analysis rules

- A candidate string or escape sequence is a pattern only after repeated,
  blinded evaluation against held-out runs.
- Pattern training and scoring use different runs.
- Pattern matches may label terminal presentation, never authorization or
  irreversible control.
- A PTY parser runs out of the rendering hot path and fails open: unparsed bytes
  still reach xterm unchanged.

## Experiment D: source correlation

Merge all observations by monotonic time into `timeline.ndjson` and evaluate
these questions per labeled phase:

1. Which source detects the phase first?
2. Which source remains correct throughout the phase?
3. What conflicting evidence appears?
4. Is there a truthful label available when the provider is quiet?
5. Does the combined model outperform the present three-second output timer?

The analysis must include a timeline view for at least one run of each scenario:

```text
time ─── PTY output ─── hook PreToolUse ─── child shell ─── PostToolUse ─── Stop
             │                    │                 │                │
          output_recent       tool_in_flight   child_process_active  completed
```

## Reproducibility prerequisites

The requested qmd codebase index could not be refreshed during planning because
the installed `qmd` command's `better-sqlite3` binary has a Node ABI mismatch.
Before implementation, repair or reinstall qmd, index this checkout, retrieve
the relevant PTY/activity/hook documents, and repeat the AST outline. This is a
tooling prerequisite, not evidence about agent activity.
