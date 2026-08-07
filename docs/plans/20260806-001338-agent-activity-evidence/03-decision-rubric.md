# Decision rubric and implementation gates

## Evidence precedence

Do not reduce all observations to one opaque `active` boolean. Preserve source
and confidence, then derive a small explainable presentation state.

| Priority | Evidence | Example UI wording | May control behavior? |
| --- | --- | --- | --- |
| 1 | Direct lifecycle hook | `Waiting for permission` | Only a user-selected, documented policy may act |
| 2 | Direct PTY/root exit | `Exited (code 1)` | Close/cleanup state only |
| 3 | Hook tool/subagent/task boundary | `Bash running`; `2 subagents active` | No automatic tool control |
| 4 | OS process observation | `Local child process active` | Explicit stop only; never auto-kill |
| 5 | Terminal protocol | `Terminal requested attention` | Focus/notify only |
| 6 | Recent PTY output | `Output received 2s ago` | Presentation only |
| 7 | Filesystem/private state artifact | `Diagnostic session update observed` | Never live state/control |

If evidence conflicts, retain the higher-priority fact and expose the lower one
in diagnostics. For example, a hook-reported permission wait plus continuing
spinner bytes remains `Waiting for permission`, not `Active output`.

## Accuracy and cost thresholds

| Area | Ship threshold | Reject or defer when |
| --- | --- | --- |
| Process liveness | 100% correct against root start identity | PID reuse can be mistaken for the original session |
| Child-process badge | at least 99% precision in the fixture | It is described as agent work rather than local process activity |
| Hook lifecycle event | 100% correlation for tested supported events | Drops/duplicates are silent or payload needs sensitive content |
| Hook bridge impact | p95 added hook latency below 100 ms | It blocks, times out, or changes CLI behavior |
| PTY agent-specific pattern | at least 99% precision and 95% recall on held-out runs | It breaks on resize, theme, or routine CLI update |
| Output-recency display | exact byte-arrival timestamp | It is named `working`, `idle`, or `finished` |
| Observer overhead | under 1% CPU for 20 quiet test tabs at the chosen rate | Polling causes visible UI/battery cost |

The numeric thresholds are deliberately strict because a false “finished” or
false “working” indication harms trust more than showing `unobserved_quiet`.

## Implementation gates

### Gate 0: instrumentation review

Required evidence:

- fixture design reviewed for safe prompts and no-secret capture;
- qmd installation repaired and this checkout indexed;
- event schema, redaction rules, local retention, and deletion procedure agreed;
- no production source change beyond an optional isolated lab harness.

### Gate 1: OS observer

Ship only if OS-1, OS-5, and OS-6 pass. The result may add an optional
diagnostic view with `process live`, `child count`, and `local process busy`.
It must not change the meaning of the existing indicator.

### Gate 2: per-provider hook adapter

Ship each provider independently only if HK-1 through HK-5 pass. Configuration
must be an explicit machine-local opt-in, visible to the user, non-destructive,
and removable. No global hook file may be overwritten, and no automatic
permission approval is in scope.

### Gate 3: PTY semantic enhancement

Ship generic byte-recency and terminal-attention facts once PTY-1 and PTY-5
pass. Ship provider-specific parsing only if PTY-2 through PTY-4 meet their
held-out thresholds and version gating is implemented. Otherwise preserve raw
capture only in the lab.

### Gate 4: combined activity UI

Ship the merged presentation only if XR-1 and XR-2 demonstrate an improvement
over the current three-second silence model without hiding uncertainty. The UI
should prefer labels such as:

- `Waiting for your approval` (hook-confirmed)
- `Running Bash` (hook-confirmed)
- `2 local child processes active` (OS-confirmed)
- `Output received recently` (PTY-confirmed)
- `Running, no current provider signal` (root live, otherwise quiet)
- `Exited with code 1` (PTY/root-confirmed)

## Explicit non-goals for a first implementation

- Predicting private model reasoning or productivity from CPU, RAM, silence, or
  token-like terminal animation.
- Parsing private transcript formats as a live control protocol.
- Automatically approving permissions, stopping subagents, or killing a process
  because a heuristic labels it stale.
- Attaching to agent sessions that Shep did not launch.
- Persisting raw PTY data, prompts, file contents, tool arguments, or command
  output outside a short-lived approved experiment capture.

## Recommended order after the plan is approved

1. Repair and index qmd; create the isolated experiment harness and baseline
   recorder.
2. Run OS-only fixture matrix for Claude and Codex; publish the first timelines.
3. Decide whether process observation provides enough value to keep.
4. With a separate explicit opt-in, run hook bridge fixtures for one provider at
   a time.
5. Run PTY analysis only after hook labels are available as independent ground
   truth.
6. Review the data and choose the smallest shippable capability tier.
