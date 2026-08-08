# Phase 8 — full-application verification

## Outcome

Prove the complete agent-operated lifecycle in a packaged Shipctl application,
including the mission-critical invariant that the terminal performing the change
survives and remains interactive.

## Work package 8.1 — packaged-app driver

Add an application integration driver under `ops/module-control/` that:

- launches named packaged instances through `shipctl ui start` with isolated
  state roots and explicit project workspaces;
- discovers and stops them through the Step 0 public instance protocol;
- loads a saved baseline state when the scenario requires reproducible setup;
- uses application UI automation to open a real Shipctl terminal;
- runs the installed `shipctl` CLI inside that terminal, exercising injected
  `SHIPCTL_INSTANCE_ID` selection;
- observes operations through revision events rather than fixed sleeps; and
- captures redacted evidence using the Phase 7 bundle contract.

The driver may control test fixtures and process lifetime. It may not invoke a
private lifecycle endpoint, mutate the registry database, or read frontend
stores as its success oracle.

## Work package 8.2 — successful mission scenario

Run this sequence with a generic fixture capability and at least one migrated
resource-owning module:

1. Start Shipctl with fixture A active and open the originating terminal.
2. Prove the terminal accepts a nonce command and returns the matching output.
3. Add and enable immutable fixture B through the CLI.
4. Verify B's evaluated marker, contributions, digest, and applied revision.
5. Reconfigure B and verify the effective redacted configuration revision.
6. Disable B and prove its public contributions disappear.
7. Re-enable B and prove a fresh instance identity owns its contributions.
8. Roll back to A and prove A's immutable marker is evaluated again.
9. Remove the unreferenced B artifact and verify logical and physical state.
10. After every committed transition, send a new nonce through the originating
    terminal and prove its ordered response.

The resource-owning case also starts work under A, updates to B, proves new work
routes to B, and proves A continues serving its leased resource until natural
release.

## Work package 8.3 — failure and recovery mission scenario

From the last good active version:

1. Submit an artifact that fails preflight and prove no desired activation
   revision changes.
2. Submit C that passes preflight but fails activation.
3. Verify the last good version and catalog remain public.
4. Verify C owns no public contribution and leaks no unleased handle.
5. Verify the operation reports its exact failed phase and remediation.
6. Submit a valid subsequent version and prove the instance recovers live.
7. Prove the originating terminal remains interactive throughout.

Also submit a restart-required change and prove it is rejected before commit;
the test must not accept a webview reload as recovery.

## Work package 8.4 — multiple running instances

Launch two named running instances with distinct writable state roots. Once the
transactional module registry supports an explicitly shared service root, point
both at that one deliberate test registry while retaining distinct instance
profiles and runtime endpoints. Prove:

- untargeted CLI commands fail as ambiguous;
- explicit and injected instance selection query the correct observed state;
- a global desired revision is independently observed by both supervisors;
- one instance can lag or disconnect without falsifying the other's result; and
- per-instance observations remain distinct in inspection and operations.

Where a module supports workspace configuration, use distinct workspace
identities to prove the scope is not inferred from target instance.

The driver must also prove `instances list` shows both names, and must stop both
through the CLI. Test cleanup must not signal descriptor PIDs or touch the
production `main` state root.

## Diagnostic and verification mechanism

`shipctl diagnose --output json` is the final application oracle. It aggregates
registry integrity, instance handshake, revision convergence, catalog ownership,
module checks, effective grants, activation scopes, leases, and correlated
operation failures.

The evidence bundle includes expectation results for every transition and the
terminal nonce transcript limited to the generated test nonces. It excludes
ordinary user terminal content.

Planned entry point:

```text
just module-control e2e --output json
```

## Exit proof

- Both success and failure scenarios pass through the packaged application.
- Every expected outcome is proven by public CLI diagnostics or UI observation,
  not internal store access.
- Runtime markers prove evaluated code identity rather than changed files.
- The originating terminal's webview, session, and PTY remain usable across all
  live lifecycle operations.
- Desired and observed states converge by revision in each selected instance.
- The final full diagnostic has no failed consistency checks.
- The generated evidence bundle validates and contains no configured secrets.
- `just module-control all`, `just check all`, and `just test full` pass.

## Release tripwire

Do not claim live agent reconfiguration for a runtime kind, module, or packaged
platform unless its corresponding full-application lane produces this proof.
A unit, browser fixture, dev server, or settings-UI demonstration is insufficient.
