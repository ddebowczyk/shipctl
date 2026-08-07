# Agent activity evidence experiment plan

Created: 2026-08-06 00:13 CEST

## Goal

Establish which locally available signals can truthfully describe and control a
Shep-launched interactive Claude Code or Codex session without using an SDK,
App Server, or separately metered provider API.

The output is an evidence-backed decision on a small activity model, not an
implementation commitment. In particular, this work must not equate a quiet
terminal, low CPU, or no child process with an idle agent.

## Scope and constraints

- Keep the normal interactive Claude Code and Codex CLIs, authenticated as the
  user already uses them.
- Do not use the Codex App Server, the Codex/Claude SDKs, or a provider API.
- Observe only Shep-launched test sessions. Never attach to, signal, or inspect
  unrelated user processes.
- Run all experiments in a disposable, non-secret test directory. Capture no
  real prompts, source code, credentials, or arbitrary command output.
- Do not alter `~/.claude` or `~/.codex` during the planning phase. A hook
  experiment needs a separately approved, reversible test configuration.
- Treat provider transcripts and state files as private, version-dependent
  artifacts. They may be evaluated as a diagnostic signal but not as an
  authoritative integration contract.

## What an event means here

An event is a timestamped observation emitted by a local source. It is not
automatically a provider event.

| Source | How Shep can access it | Example | Strength |
| --- | --- | --- | --- |
| PTY | Existing Tauri `Channel<PtyOutput>` | bytes arrived; PTY closed | Exact transport fact, weak semantics |
| OS process | Poll a known PTY root and descendants; receive known-PID exit | root alive; child shell uses CPU | Exact OS fact, suggestive semantics |
| Hook bridge | Provider invokes a configured local command with JSON on stdin | `PreToolUse`; `SubagentStop` | Strong provider lifecycle fact |
| Terminal control sequence | Parse bytes already flowing through the PTY | BEL; OSC notification | Exact terminal-protocol fact |
| Filesystem | Watch an allowlisted test path | provider session file changed | Weak, private-artifact signal |

The app converts raw observations into a versioned local envelope:

```text
Observation {
  run_id, provider, pty_id, observed_at_monotonic,
  source: os | hook | pty | terminal_protocol | filesystem,
  kind, reliability: exact | strong | heuristic,
  correlation_ids, redacted_payload
}
```

The envelope preserves where a claim came from. A UI state may only use wording
that matches its evidence: for example, `Tool running: Bash` for a hook event,
`Child process active` for an OS sample, and `Output received recently` for a
PTY sample.

## Existing Shep baseline

The current checkout already provides a useful control group:

- [`PtySession`](../../../src-tauri/src/pty/session.rs) owns the root PID and
  forwards only `data` and `exit` to the frontend.
- [`usePty`](../../../src/hooks/usePty.ts) marks a tab active on output, then
  clears it after three seconds of silence.
- [`PtySession::request_termination`](../../../src-tauri/src/pty/session.rs)
  walks descendants only when stopping a session; it does not sample them while
  the session runs.
- [`ActivityIndicator`](../../../src/components/sidebar/ActivityIndicator.tsx)
  already separates live/quiet, output, attention, and failed presentation.

The experiment must preserve this behavior as the baseline and record its
false-positive and false-negative rate before changing it.

## Work packages

1. [Hypotheses and signals](01-hypotheses-and-signals.md)
2. [Experiment protocol and fixtures](02-experiment-protocol.md)
3. [Decision rubric and implementation gates](03-decision-rubric.md)

## Definition of success

The work succeeds when the evidence supports one of these honest outcomes:

- **OS-only improvement:** show exact process liveness and optional child
  activity, without calling it agent activity.
- **Opt-in hook bridge:** show provider-confirmed session, tool, approval,
  subagent, task, and turn events for providers that emit them.
- **PTY enhancement:** show output and terminal attention facts only, with any
  agent-specific pattern explicitly version-gated.
- **No ship decision:** retain the current output indicator if a proposed
  signal cannot meet the accuracy, privacy, and overhead thresholds.

## Primary references

- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks-guide)
- [Claude CLI streaming options](https://code.claude.com/docs/en/cli-usage)
- [Claude subagents](https://code.claude.com/docs/en/sub-agents)

These documents establish that hooks are lifecycle callbacks in the existing
CLIs, not SDK usage. The experiments still need to confirm their behavior in
the installed CLI versions and Shep's PTY environment.
