# Runtime and registry replacement

## Objective

Replace `PtyManager` and `PtySession` with a host-owned `TerminalService` and an
ordered per-terminal runtime. This slice fixes the kill-lock, dead-channel,
child-reap, and double-shell defects, creates stable terminal identity and
durable exit state,
and establishes the only backend ownership model used by later attachments,
the renderer, modules, and the control socket.

This is a core backend change. The final code must not keep `PtyManager` as an
alternative implementation.

## Required outcome

After this slice:

- the app host can list and get running or exited terminal records by opaque
  `TerminalId`;
- PTY I/O, child lifecycle, VT parsing, and replay generation are serialized by
  one terminal runtime;
- no global registry lock is held during a fallible or blocking operation;
- natural exit is retained as state until explicit close;
- shell and direct-program launches have distinct, correct semantics;
- every child path ends in a confirmed wait/reap path;
- close preserves Shipctl's escaped-descendant cleanup behavior.

The output subscriber API is completed in the next slice, but the runtime must
publish through a transport-neutral event sink from the start. It must not own
a Tauri `Channel`.

## Immediate safety patch

Land or stage these changes before the full replacement if the branch will run
the old backend for any meaningful period. Reuse their regression tests for the
new runtime.

1. In `PtyManager::kill`, remove the session while holding the map lock, drop
   the guard, and only then call `session.kill()`.
2. In `PtyManager::kill_all`, drain sessions and mark shutdown under the lock,
   drop the guard, and terminate the drained values afterward.
3. Make output-channel failure enter one idempotent completion path. It must
   remove manager state, terminate the process if still running, and wait for
   the child. The PTY reader must break to a shared epilogue rather than return
   before `child.wait()`.
4. Introduce explicit launch targets. Stop passing `${shell} -l` as a command
   that is then wrapped in another login shell.

Do not over-polish old types. Once equivalent tests pass against
`TerminalService`, delete this temporary code.

## Target backend structure

Use capability-owned files under `core/backend/src/terminal/`. The exact file
split may follow implementation pressure, but responsibilities must remain
separate:

```text
mod.rs          exports the terminal capability API
types.rs        IDs, launch request, descriptor, lifecycle, exit, metadata
service.rs      TerminalService registry and application-level operations
record.rs       one terminal's durable state and subscriber directory
runtime.rs      ordered PTY/child/VT owner and command protocol
process.rs      process-tree discovery and termination
replay.rs       selected VT adapter and replay DTOs
commands.rs     thin Tauri command adapters
tests/...       behavior-level runtime, service, and process tests
```

Do not create a catch-all manager that repeats the current problem under a new
name. `TerminalService` coordinates records. `TerminalRuntime` owns one
terminal's mutable execution.

## Rust domain types

Define an opaque UUID-backed `TerminalId` with `Display`, `FromStr`, serde, hash,
ordering, and Tauri serialization. Serialize it as a string. Mint it before the
child exists so startup, environment injection, metadata, and failure cleanup
refer to one identity.

Define:

```rust
enum TerminalLaunchTarget {
    Shell { shell: Option<PathBuf> },
    Program { program: PathBuf, argv: Vec<String> },
}

enum TerminalLifecycle {
    Starting,
    Running,
    Closing,
    Exited(TerminalExit),
}

struct TerminalExit {
    code: Option<i32>,
    reason: TerminalExitReason,
    observed_at: ...,
}

struct TerminalDescriptor { /* redacted public state */ }
struct TerminalSpawnRequest { /* target, cwd, env, size, metadata */ }
```

Use an internal monotonically increasing revision on each record. Every
descriptor-producing mutation increments it: running, resize, metadata change,
output/activity marker, closing, exit, and agent state. Sequence overflow is an
explicit fatal invariant error; do not silently wrap IDs or revisions.

Validate terminal dimensions before allocating parser grids or spawning. Keep
the current accepted dimension contract unless the VT proof demonstrates a
stricter technical bound. Any new bound must cite its allocation or transport
derivation in code.

## Launch semantics

Make launch intent explicit all the way from Tauri/module requests to the PTY:

### Shell

`Shell { shell: None }` resolves the configured/user shell once and directly
spawns it as a login shell. Construct `argv[0]` or the platform-specific login
flag in one helper, covered by process-argv tests. Do not send the shell through
`-c`, and do not append a second `-l` in the frontend.

### Program

`Program { program, argv }` directly calls `CommandBuilder::new(program)` and
`args(argv)`. It must preserve empty strings, spaces, quotes, Unicode, and
argument boundaries. It must never concatenate values into shell source.

If a future caller genuinely needs shell source, add a separately named and
reviewed launch variant with its own trust contract. Do not overload `argv` or
`None` to mean shell evaluation.

### Environment

Build the child environment in the host and inject:

- `SHIPCTL_INSTANCE_ID`, preserving current behavior;
- `SHIPCTL_TERMINAL_ID`, always overwritten with the host-minted ID;
- existing terminal capability defaults such as `TERM`/`COLORTERM` where
  Shipctl already owns them.

Never place the environment in `TerminalDescriptor`. Tests must use a sentinel
secret to prove redaction.

## Ordered terminal runtime

Model the runtime as one actor/worker per terminal. A practical implementation
can use a dedicated thread plus bounded command/output queues, similar to Fut,
or an equivalent executor that proves the same ordering. The runtime owns:

- PTY master and writer;
- child handle and confirmed wait;
- continuous VT adapter;
- canonical rows/columns;
- output and lifecycle sequence;
- control-sequence responses written back to the PTY;
- close state.

The command protocol must include at least:

- write bytes with completion/error;
- resize with completion/error;
- attach and detach subscriber operations used by the next slice;
- snapshot/replay request for get/diagnostics;
- close with completion;
- metadata/query operations that truly require runtime ordering.

Use separate command and PTY-output ingress so a flood cannot permanently
starve input, resize, or close. Any queue capacity or drain budget must be
derived from current flow-control constants, the chosen VT adapter, or measured
latency/transport constraints and documented beside the constant. Do not copy
Fut/cmux constants blindly.

Initialize every fallible PTY resource and the VT parser before spawning the
child. Once the child exists, exactly one owner is responsible for killing and
waiting if any later initialization step fails.

The PTY reader may run separately because reads block, but it sends bytes/EOF/
error to the runtime. It never owns lifecycle publication. On reader EOF or
error, the runtime drains all already-sequenced bytes into the parser, obtains
the child's status, publishes final replay/state, and transitions to exited.

## Continuous VT and PTY responses

Feed every PTY output byte to the selected VT adapter before publishing it to
subscribers. The adapter begins before child spawn, so a later attachment can
recover state established by the earliest output.

Terminal-generated answers—device attributes, status reports, cursor position,
color queries, and any existing Shipctl query responses—must be written back to
the PTY in the same runtime order. Keep the current query responder until the
selected adapter proves equivalent coverage. Remove it only after fixture tests
show one authoritative responder and no duplicate replies.

Theme/default-color changes that affect replay must be terminal-runtime
commands. A descriptor/theme update and its replay revision must be observed
atomically; do not mutate a parser from Tauri command code.

## TerminalService registry

`TerminalService` is app-process state managed by Tauri and passed to module
adapters where needed. Its registry shape is conceptually:

```rust
struct TerminalService {
    instance_id: Arc<str>,
    records: Mutex<HashMap<TerminalId, Arc<TerminalRecord>>>,
    shutting_down: AtomicBool,
}
```

The registry lock may only:

- reject spawn while shutting down;
- reserve/insert a new record;
- clone a record handle for get/write/resize/attach/close;
- create a descriptor list from briefly locked record snapshots;
- remove an explicitly closed record;
- drain record handles during host shutdown.

It must be dropped before:

- opening a PTY or spawning a child;
- sending to or waiting on the runtime;
- invoking a Tauri channel or control-socket writer;
- waiting for exit;
- sleeping through a termination grace period;
- scanning descendants or sending signals;
- serializing a large replay.

Use a startup reservation/record in `Starting` state so IDs are unique and
cleanup is deterministic. On spawn failure, record the failure for the caller,
remove the reservation, and ensure no child survives. Do not expose a phantom
running descriptor.

## Record lifecycle and retention

A `TerminalRecord` is retained through natural exit:

```text
Starting -> Running -> Exited
                    -> Closing -> Exited -> removed by close
```

Rules:

- `Running` begins only after the child and runtime are ready.
- Natural exit records final status/reason and releases PTY/child resources but
  does not remove the record.
- `running_count` and application shutdown blockers count only starting,
  running, or closing records—not retained exited records.
- `close(id)` is idempotent. For a running record it marks closing, removes or
  tombstones it under the registry lock, drops the lock, terminates/reaps, then
  reports success. For an exited record it removes metadata without signaling.
  For an absent record it reports an explicit successful no-op (`existed:
  false`) rather than failing retries.
- Application shutdown drains registry handles under lock, drops the lock, and
  terminates running children. Exited records require no process work.
- A late natural-exit callback racing explicit close is accepted exactly once;
  duplicate finalization is harmless and does not recreate the record.

If UI needs to display an exited tab, it receives the retained descriptor.
Explicit close from the UI removes both the host record and frontend
projection.

## Process termination

Extract the proven termination logic from `session.rs` into `process.rs` and
make it callable without any service/record lock.

Preserve:

- process-group signaling;
- recursive descendant discovery used for descendants that escape the original
  group/session;
- the existing graceful-to-forceful escalation behavior and its current
  technically established duration;
- final confirmed `child.wait()`;
- idempotence when the process exited concurrently.

Improve ownership:

- capture descendant identities before signaling as the current logic
  requires;
- never signal Shipctl's own group;
- isolate platform-specific behavior;
- return a structured termination result for diagnostics and exit reason;
- ensure a failed signal attempt still reaches wait/reap or an explicit error
  state.

Test an actual descendant that invokes `setsid`, not only an ordinary child.

## Tauri command transition

Keep `core/backend/src/terminal/commands.rs` thin. Commands should parse wire
DTOs, call `TerminalService`, and serialize results. They must not lock records,
spawn threads, or implement process policy.

Introduce string-ID commands behind the final names:

- spawn shell/program;
- list/get descriptors;
- write;
- resize;
- close;
- update safe metadata;

Attachment commands arrive in the next slice. A short-lived adapter may accept
the old command shape during call-site migration, but it must delegate to the
new service and be listed for deletion in the cutover document.

## Tests

### Runtime tests

- Parser is ready before child spawn and sees earliest output.
- Direct program receives exact argv without a shell parent.
- Blank shell has one login-shell wrapper.
- Output delivery failure cannot bypass wait/reap.
- EOF flushes queued output before final replay and exit publication.
- Write and resize reject exited terminals with typed errors.
- Repeated close is safe.
- Query responses are written exactly once.
- Resize changes canonical dimensions and replay state in one order.

### Registry tests

- IDs remain stable across list/get and are never reused.
- Concurrent spawn reserves distinct IDs.
- Terminating A does not block write/resize/list for B.
- `close` and natural exit racing leave no live child and no recreated record.
- Exited records are listable; `running_count` excludes them.
- Shutdown drains under lock and terminates outside it.
- Descriptors never serialize argv/environment sentinel values.

### Process tests

- ordinary foreground command is terminated and reaped;
- escaped `setsid` descendant is terminated;
- already-exited child makes close succeed;
- process-group fallback never targets Shipctl's own group.

## Acceptance criteria

This slice is complete when:

- all backend terminal operations use `TerminalId` and `TerminalService`;
- the replacement runtime owns child/PTY/VT state without a Tauri channel;
- the kill-lock, child-reap, and double-shell regression tests pass;
- exact current replay is available from the runtime selected by the proof;
- natural exits remain discoverable until close;
- active-work/shutdown counts use lifecycle rather than map size;
- no backend code performs termination while holding the registry lock;
- old `PtyManager`/`PtySession` code is either deleted or has only a named,
  temporary adapter with a mandatory deletion task in the same refactor.

## Files expected to change

- `core/backend/src/terminal/*`
- `core/backend/src/lib.rs` terminal exports/state registration
- `core/backend/Cargo.toml`
- `src-tauri/src/lib.rs` or the existing Tauri builder state setup
- `src-tauri/src/lifecycle.rs` active-work/shutdown integration
- backend terminal tests and process fixtures

Do not put terminal behavior in `src-tauri/`; that crate remains the app-bundle
shell and adapter layer.
