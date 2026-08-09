# Execution order and lean task contract

## Remaining critical path

```text
Phase 3 packages + capability contracts
  -> Phase 4 live capability provider runtime
  -> Phase 5 lifecycle + agent call/watch/attach
  -> scheduler live-module delivery + Phase 6 production migrations
  -> Phase 7 build/pack/dev loop
  -> Phase 8 packaged agent-operability proof
```

The message-bus epic and scheduler S1–S4 are closed foundations. Scheduler S5
delivery to activated module endpoints waits for the Phase 4 snapshot. Terminal
migration starts as soon as the Phase 5 agent surface exists because it proves
the hardest native-resource and stream boundary.

## Gate dependencies

<!-- markdownlint-disable MD013 -->

| Work | Requires | Proves |
| --- | --- | --- |
| Phase 3 package and contracts | loader seam, registry, local IPC, bus contracts, scheduler S4 control surface | disabled artifact can define an inspectable capability |
| Phase 4 provider runtime | Phase 3 artifact and preflight | atomic A-to-B routing and C rollback |
| Phase 5 agent operations | Phase 4 snapshot and observations | lifecycle plus capability call, event watch, and stream attach |
| Scheduler live delivery | scheduler core and Phase 4 routes | file refresh reaches exact module endpoint |
| Phase 6 terminal migration | Phase 5 APIs and stream contract | PTY continuity through provider replacement |
| Remaining Phase 6 migrations | fixture and terminal conformance | production capabilities are replaceable and agent-operable |
| Phase 7 development loop | stable Phase 3–6 public contracts | deterministic source-to-running-digest workflow |
| Phase 8 packaged proof | required production migrations and dev loop | release-level agent operability |

<!-- markdownlint-enable MD013 -->

## Lean execution rule

Work the smallest coherent vertical slice that closes the phase outcome and
prove it at the public boundary.

- Do not create mandatory action-plan files, one task per document, or a
  discovery-tool checklist.
- Create a child issue only when it represents independently verifiable work
  that cannot be completed coherently in the parent subepic.
- Use repository tools because they answer a necessary question, not to satisfy
  ceremony.
- Add the production diagnostic with the behavior it proves.
- Reuse one integration fixture across contracts, activation, lifecycle,
  scheduler, and packaged proof.
- Run focused checks for the changed contract. Run the larger packaged gate only
  when its boundary changes or when closing the dependent phase.
- Do not rerun an already proven unchanged gate.

Durable operations and watchers remain because reconciliation crosses durable
state and running processes. Their vocabulary should stay as small as observed
behavior permits. The message bus remains ephemeral and is not an operation
journal.

## Cross-phase fixture mission

One fixture carries the contract through the next phases:

1. Phase 3 defines a new capability, validates its provider and consumer
   bindings, selection rules, and declared agent surfaces, installs its
   artifact disabled, and exposes that metadata through offline inspection.
2. Phase 4 activates its typed port, event, UI asset, and scheduler endpoint,
   replaces A with B atomically, rejects invalid C while B remains the selected
   active provider, and disables or removes it.
3. Phase 5 lets an external agent discover and invoke it and watch its declared
   event against a named instance.

This is a cross-phase proof, not the Phase 3 exit criterion. Phase 3 closes at
the disabled artifact and preflight boundary; do not pull live lifecycle or
agent operations into it, nor expand Phase 4 into a general distributed
orchestrator.

## Verification policy

Evidence is sized to the claim:

1. schema or unit proof for local invariants;
2. compiled-service or running-instance proof for a changed mechanism;
3. public CLI proof for agent-visible behavior; and
4. packaged end-to-end proof when runtime, native-resource, packaging, or
   continuity boundaries change.

Each fact has one authoritative diagnostic. Generated evidence may compose
those diagnostics but must not duplicate application state or become a second
control plane.

## Explicitly rejected claims

- A central exhaustive capability catalog is unnecessary; modules may define
  versioned capabilities under the host meta-contract.
- Runtime npm installation is unnecessary; npm/pnpm is a source and optional
  distribution tool, while Shipctl installs immutable artifacts.
- A REST listener is unnecessary; exact instance access uses same-user local
  IPC.
- Use Tauri commands and channels conventionally at the native/webview boundary;
  ordinary Tauri events remain appropriate for lightweight shell/UI
  notifications. Dynamic capability routing still needs the application bus for
  schema, grants, activation ownership, and inspection.
- Persisting bus events, terminal bytes, or schedule ticks in the core registry
  is unnecessary and risks unbounded writes.
- Compile-time Cargo features cannot prove runtime module lifecycle.
- Reload-safe PTY transport is not a substitute for live reconciliation;
  terminal migration gives sessions stable identity and attachable streams.
- New native Rust or Tauri registrations are not live-loadable.
