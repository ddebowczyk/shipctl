# Phase 8 — packaged agent-operability verification

## Outcome

Prove through a packaged Shipctl application that agents can manage modules and
operate their capabilities while the host binary, webview, running terminals,
and unrelated providers remain intact.

## Work package 8.1 — public packaged driver

Drive only shipped boundaries:

- launch named instances with isolated state roots and workspaces;
- use `shipctl` over the same-user local instance protocol;
- install immutable module artifacts;
- inspect modules, capabilities, providers, scheduler state, and streams;
- invoke typed ports, watch declared events, and attach to authorized streams;
- observe operation completion rather than sleeping; and
- stop instances through the public CLI.

The driver may control fixture inputs and process lifetime. It may not mutate
the registry, invoke private endpoints, read frontend stores, or treat a source
file change as proof that code was evaluated.

## Work package 8.2 — fixture vertical mission

Using one unchanged packaged host binary:

1. start a named instance;
2. add fixture A disabled and inspect its module-defined capability;
3. enable A and discover its active provider;
4. call its typed port and watch its declared event;
5. refresh its schedule file and trigger the schedule-addressable endpoint;
6. replace A with B and prove new calls route to B;
7. submit invalid C and prove B remains the selected active provider, public,
   and callable;
8. reconfigure B without rebuilding code;
9. disable and remove B and prove its routes and contributions disappear; and
10. verify the host binary digest, webview identity, and unrelated runtime state
    did not change.

The proof also confirms that routine bus messages, events, schedule ticks, and
stream payloads were not persisted by the core runtime.

## Work package 8.3 — production capability mission

Run the same public-boundary proof against migrated production capabilities:

- attach the UI and an external agent to one terminal stream;
- replace the TypeScript terminal provider while the PTY remains alive and
  ordered output continues to both observers;
- use an assistant or agent-session capability that consumes terminal APIs;
- inspect and operate project-browser capability state; and
- prove disabling or replacing one provider does not alter unrelated providers.

Failure cases cover stale preconditions, denied private routes, invalid input,
preflight rejection, activation failure, drain blockers, and subsequent live
recovery.

## Work package 8.4 — multiple named instances

Launch two named instances with distinct state roots and workspaces. Prove:

- untargeted commands fail when selection is ambiguous;
- `--instance` and injected instance identity select the correct process;
- module, capability, schedule, event, and stream observations remain
  instance-specific;
- one instance can be stopped or lag reconciliation without falsifying the
  other's state; and
- state save and load do not merge process identity or runtime endpoints.

If a later shared registry mode exists, test its global desired state separately
from per-instance observed state. It is not required for ordinary multi-instance
support.

## Diagnostic and verification mechanism

`shipctl diagnose --output json` is the final consistency oracle. It joins
instance handshake, registry integrity, desired and applied revisions, module
artifacts, capability definitions and providers, catalog ownership, bus routes,
scheduler generation, streams, resources, leases, and operation failures.

The evidence bundle contains only the structured facts and generated test
nonces necessary to reproduce the result. It excludes secrets and ordinary
terminal content.

## Exit proof

- The complete fixture mission passes through the packaged CLI and UI runtime.
- Terminal, assistant/session, and project-browser capability proofs pass
  through public agent surfaces.
- A, B, C, configuration, schedule, and lifecycle transitions require no Rust
  rebuild or webview reload.
- The originating terminal PTY and both authorized observers remain usable.
- Two named instances are independently targetable and inspectable.
- Every failure leaves the last good snapshot usable and produces a stable
  diagnostic.
- The final full diagnostic reports no failed consistency check and no core
  persistence of ephemeral traffic.

## Release tripwire

Do not claim live agent operability for a capability or runtime kind until its
packaged lane proves management, invocation or observation, failure recovery,
and continuity through the public instance protocol.
