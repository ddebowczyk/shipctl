# Target design and policy

## Ownership model

The target is one lifecycle with two policy layers:

```text
child process
    |
    v
Rust PtySession / PtyManager
wait, classify, reap, count, terminate only on request
    |
    | existing per-PTY Tauri Channel<PtyOutput>
    v
TypeScript PTY lifecycle handler
flush output, update activity/command/restore state
    |
    v
tab-role policy
blank shell / saved command / assistant
```

Rust decides what happened to the process and owns resources. TypeScript
decides what the product should do with the corresponding tab.

## Host-side lifecycle

Use explicit process and stream state even if represented compactly in code:

```text
Process: Running -> Exited(status)
              \-> StopRequested(user|shutdown) -> Exited(status)

Stream:  Open -> Draining -> Drained

Session: Managed -> Completion coordinated -> Reaped
```

Normal event delivery waits for both the authoritative child status and final
stream drain. The implementation must also define a tested, bounded policy for
a descendant that keeps the slave stream open after the shell exits. Closing
the PTY master can itself produce terminal hangup behavior, so that policy must
distinguish normal terminal ownership from a genuinely detached child with
independent standard streams.

Required invariants:

1. Every spawned PTY reaches host-side removal exactly once.
2. Natural completion never invokes process-tree termination.
3. Requested close and shutdown remain bounded and may force-kill survivors.
4. The frontend exit event is delivered at most once per PTY.
5. `kill_pty` remains idempotent when completion won the race.
6. Session count includes only host-managed live or actively terminating PTYs.
7. Final data precedes the completion event on a given PTY channel.
8. A descendant-held slave cannot keep a completed shell tab hanging forever.

The likely implementation coordinates a child-wait result and reader-drain
result, then notifies manager-owned cleanup. Assigning the PTY ID before spawn,
introducing an `Arc`-backed manager inner, or using an internal completion
queue are viable seams. The implementer must choose after the required
re-baseline rather than copying this snapshot's exact structure.

Do not route high-volume PTY data through a new global Tauri event bus. Keep the
existing channel for ordered per-session data and completion.

## Event contract

The minimum compatible event remains:

```ts
type PtyOutput =
  | { event: "data"; data: string }
  | { event: "exit"; data: { code: number } };
```

The preferred next contract, if characterization proves it removes the current
`stoppingPtys` race, adds process facts rather than UI policy:

```ts
type PtyExitDisposition = "natural" | "requested" | "shutdown";

type PtyExit = {
  code: number;
  success: boolean;
  disposition: PtyExitDisposition;
};
```

This shape is a design candidate, not a pre-approved schema. Before adopting
it, prove:

- how requested-close events are delivered when the UI is already removing a
  tab;
- how shutdown suppresses mutations that conflict with assistant continuity;
- whether `success` should be serialized or consistently derived from code 0;
- how duplicate delivery is prevented;
- compatibility with both direct PTY spawn and assistant-session spawn.

Do not add a `signal` field until the host can obtain one through a supported,
tested API.

## Frontend lifecycle handler

Create one testable completion path used by blank shells, saved commands, and
assistants. It should perform operations in this order:

1. Stop activity timers and mark the PTY completed.
2. Flush pending xterm data for that PTY.
3. Apply assistant restore/capture rules and saved-command status updates.
4. Resolve the current tab and its explicit role.
5. Apply the role policy below.
6. Remove cached terminal/activity state only when the tab is actually removed.

The handler must tolerate a missing tab because close, project removal, or
shutdown can win the race. Repeated completion must be a no-op.

Avoid making `AppShell` the lifecycle owner. It may supply or consume tab-host
ports, but PTY completion orchestration belongs in the terminal runtime hook or
the stable replacement established by the refactor.

## Tab-role policy

### Blank interactive shell

On natural status 0:

- do not call `kill_pty`;
- flush pending output;
- dispose/unregister the xterm instance;
- remove activity state;
- remove the tab from its current placement project;
- let the tab store's deterministic neighbor-selection logic choose focus.

On natural non-zero status:

- keep the tab and scrollback;
- mark it completed and non-interactive;
- show `Terminal exited with status N` in app-owned UI;
- offer an explicit close action;
- closing this already-reaped tab must only forget frontend state.

`exit`, `logout`, and end-of-file should not be parsed from typed input. The
authoritative trigger is the PTY completion event, which also handles scripts,
signals, and shell-internal completion behavior.

### Saved workspace command

Retain the tab and output for both zero and non-zero completion. Preserve the
current command status and PTY-ID clearing behavior unless a separate product
decision changes it. Do not let the blank-shell convenience policy erase build
or server output.

### Assistant session

Preserve restore probation, capture, rearm, discard, and shutdown-freeze
semantics. Do not auto-close assistant tabs as part of this feature. A future
assistant-specific policy can consume the same lifecycle facts.

### Explicit close and application shutdown

If the process is live, use requested bounded termination. If host completion
already won, treat close as frontend-only cleanup. Both paths must be
idempotent.

Application shutdown keeps the established order: freeze assistant restore
mutations, request termination for all PTYs, share one grace deadline, then
force-kill survivors.

## Non-zero status UI

Render completion state outside xterm's byte stream. A compact banner or
overlay should include:

- neutral status text;
- a close button;
- sufficient contrast in all themes;
- keyboard focus behavior and an accessible label;
- no cursor or input affordance suggesting the process is alive.

An overlay is preferable to writing `Process exited...` into xterm because it
preserves the provenance and ordering of child output, avoids ANSI/copy-paste
contamination, and remains available even when the final process output does
not end with a newline.

The terminal input callbacks and custom keybinding path must check lifecycle
state before invoking `write_pty`. A completed retained tab should not generate
console-only write failures.

## Cleanup API boundary

Prefer host-owned automatic removal on natural completion. A frontend command
such as `release_exited_pty` is an acceptable temporary migration seam only if
the live refactor prevents host-owned cleanup, and only with all of these
properties:

- it cannot signal a process tree;
- it verifies the PTY is no longer alive;
- it is idempotent;
- missed frontend delivery is recovered by host cleanup or shutdown;
- it is explicitly documented as transitional.

Do not overload `kill_pty` with a boolean such as `kill: false`; separate names
make destructive intent auditable.

## Rollback strategy

Keep backend correctness and frontend convenience independently reversible:

- Host reaping can ship with retained-tab behavior and should remain enabled.
- Blank-shell status-0 auto-close can be guarded by one policy function or
  short-lived feature switch during rollout.
- Non-zero retained-state UI can fall back to the existing exited activity
  state without restoring dead-PTY writes.

A rollback must not reintroduce process-tree killing on natural completion.
