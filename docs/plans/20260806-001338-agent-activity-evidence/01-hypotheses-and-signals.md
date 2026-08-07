# Hypotheses and signal inventory

Read with the [plan overview](README.md). Each hypothesis must be tested on
both providers separately. A pass validates the stated narrow claim; it never
authorizes a broader semantic status.

## State vocabulary under test

The experiment labels observations, not an agent's private mental state:

| Candidate state | Permitted evidence | Disallowed inference |
| --- | --- | --- |
| `process_live` | known root PID exists with matching start identity | agent is making progress |
| `child_process_active` | known descendant exists or is consuming resources | the root agent is reasoning |
| `output_recent` | PTY bytes arrived within a measured interval | provider turn is still open |
| `needs_attention` | hook notification or recognized terminal attention signal | all attention is a permission prompt |
| `tool_in_flight` | matching hook start without a matching completion | tool will succeed |
| `provider_turn_open` | provider hook lifecycle supports it | the model is currently producing tokens |
| `unobserved_quiet` | root is live, no stronger evidence | idle, stuck, or done |
| `exited` | PTY/root exit and recorded status | provider session was saved correctly |

## OS and process hypotheses

| ID | Hypothesis | Expected result | Pass condition | Failure consequence |
| --- | --- | --- | --- | --- |
| OS-1 | The PTY root has a stable PID, process group, and start identity for an interactive session. | Both CLIs remain attributable from launch through normal exit. | No false match after rapid relaunches. | Do not retain PID-based status beyond one sample. |
| OS-2 | Recursively sampled descendants identify local tool execution. | A shell or tool child appears during a deliberate long-running local command. | High precision for the tested command phase. | Child count stays diagnostic only. |
| OS-3 | CPU/RSS deltas distinguish useful work from a stale live process. | CPU may rise during local tools, but remote waiting and reasoning can be quiet. | Only a narrow `local_process_busy` fact is reliable. | Reject CPU/RSS as an agent-active signal. |
| OS-4 | A live root with no descendants occurs during genuine provider work. | Remote/model phases often have no local child and little CPU. | At least one labeled counterexample is captured. | Require `unobserved_quiet`, never `idle`. |
| OS-5 | Child disappearance and root exit can be observed promptly enough. | Polling sees lifecycle transitions within the target sample period. | p95 detection latency is below two seconds at the selected rate. | Keep PTY exit as the only exit source. |
| OS-6 | Continuous observation is inexpensive for several tabs. | Sampling 20 idle roots is materially cheaper than terminal rendering. | CPU and wake-up cost stay below the rubric threshold. | Use a lower rate or on-demand sampling. |
| OS-7 | `kqueue` or another macOS primitive can reduce polling. | Known-root exit is eventable; arbitrary descendant creation may not be. | It adds a measurable benefit over polling. | Use bounded polling; do not add platform complexity. |

### OS inventory to record

At each sample, record the root and recursively discovered descendants with:

- PID, PPID, PGID, start time/identity, process state, elapsed time, CPU, and
  resident memory;
- executable basename and a redacted command classification, never arbitrary
  command-line arguments in production;
- child count, maximum depth, and whether the process is newly seen or gone.

The first implementation probe may use macOS `ps` plus recursive `pgrep -P`,
matching the current shutdown walker. It must separately test process groups
and `setsid` escapees, because a CLI child can detach from its original group.

## Hook and hook-bridge hypotheses

| ID | Hypothesis | Expected result | Pass condition | Failure consequence |
| --- | --- | --- | --- | --- |
| HK-1 | Existing interactive CLI hooks emit session, tool, permission, and stop boundaries. | Claude and Codex deliver the documented events in a test session. | Events correlate to the observed lifecycle in every repeat. | Limit provider support to the observed subset. |
| HK-2 | Subagent and task events identify child-agent lifecycle. | Spawn/stop events arrive for enabled subagents. | IDs/names let the bridge distinguish root and child. | Show aggregate counts only, or omit the feature. |
| HK-3 | A local bridge can accept events without blocking the agent. | A short command forwards an allowlisted event over a private Unix socket. | No hook timeout and p95 bridge latency under 100 ms. | Use append-only fallback or reject the bridge. |
| HK-4 | Event delivery can be made loss-visible and duplicate-safe. | Bridge restart/unavailable tests show sequence gaps or explicit drops. | Every gap is detectable; duplicates are idempotent. | Do not render lifecycle state as authoritative. |
| HK-5 | Hook payloads can be minimized safely. | IDs, type, timestamp, and coarse tool class are enough for UI. | No prompt, file contents, secrets, or command arguments needed. | Do not ship a capture-heavy bridge. |
| HK-6 | Per-project test hook configuration does not change normal sessions. | Hook scope is isolated to the disposable fixture. | Config removal returns the CLI to its prior behavior. | Require explicit global opt-in or abandon the test. |

The bridge must record source event names verbatim and map them later. It must
not pretend that a provider's `Stop` or task completion proves that tests passed
or that all concurrent subagents have ended.

## PTY and terminal-protocol hypotheses

| ID | Hypothesis | Expected result | Pass condition | Failure consequence |
| --- | --- | --- | --- | --- |
| PTY-1 | Byte arrival accurately indicates recent terminal output. | It matches screen activity in every run. | No loss or reordering in a recorder that observes without modifying bytes. | Fix the recorder before classifying output. |
| PTY-2 | BEL or documented OSC sequences identify terminal attention. | A controlled permission/attention state emits a repeatable sequence. | Pattern is stable across ten runs and both themes. | Keep only the existing generic bell state. |
| PTY-3 | TUI text or spinner patterns identify a provider turn state. | Some patterns may appear in one CLI version. | At least 99% precision and 95% recall against labels. | Do not ship agent-specific regexes. |
| PTY-4 | Prompt recognition identifies an idle interactive prompt. | Full-screen redraws, custom themes, and resize can break it. | It survives resize, theme, and provider-version checks. | Report only `output_recent`/`unobserved_quiet`. |
| PTY-5 | ANSI normalization can expose stable facts without changing display. | Parser extracts only protocol facts and leaves byte stream untouched. | Terminal rendering is byte-for-byte unaffected. | Do not parse in the rendering path. |

Raw PTY bytes are evidence, but agent-specific terminal text is an unstable,
privacy-sensitive presentation format. The expected outcome is that only output
recency and explicit terminal attention are useful in a first release.

## Filesystem and cross-source hypotheses

| ID | Hypothesis | Expected result | Pass condition | Failure consequence |
| --- | --- | --- | --- | --- |
| FS-1 | A provider transcript/state file change correlates with a lifecycle event. | Files often change after a turn or tool event. | The correlation is measured, not assumed. | Do not use it for live status. |
| FS-2 | File watching adds information unavailable from hooks or PTY. | It may help post-mortem diagnostics only. | It changes a decision in a controlled test. | Exclude it from runtime observation. |
| XR-1 | A source-precedence model resolves normal conflicts. | Hook says waiting while PTY is quiet; OS says root live. | The result is deterministic and explainable. | Do not merge signals into one color. |
| XR-2 | The combined model improves accuracy over the current three-second timer. | Hooks capture boundaries; PTY preserves output; OS preserves liveness. | It clears the decision rubric on held-out runs. | Retain current behavior. |
