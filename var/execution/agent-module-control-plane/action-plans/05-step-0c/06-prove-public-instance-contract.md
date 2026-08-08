# Prove the public named-instance contract

## Outcome

One repository-owned automation lane proves the complete Step 0 contract
through built `shipctl` and `shipctl-ui` binaries and leaves the operator's
default Shipctl profile untouched.

## Depends on

- Split CLI and UI executables.
- Injected instance paths.
- Authenticated local control.
- Named-instance agent CLI.
- State save and restore.

## Production change

Add the `instance-control` operations capability and public `just` entries for
contract and integration verification. Use isolated temporary state/runtime
roots and the production CLI/UI boundary; remove all temporary instances on
success and failure.

## Diagnostic or observability change

Emit a machine-readable evidence record for every operation and assertion,
including binary identities, roots, instance identities, protocol state,
archive fingerprints, source accounting, cleanup outcome, and unchanged
production-root proof.

## Mechanism-level integration test

Build the executable pair, start two pre-named isolated instances, assert list
and inspect identity, exercise duplicate-name/root rejection, save one,
restore under a third identity, compare fingerprints, stop every instance, and
prove no descriptor, lease, process, or profile mutation remains.

## Acceptance evidence

- The complete workflow uses only public CLI commands against real processes.
- Concurrent names and roots are isolated and race-safe.
- Save/restore equivalence and complete source accounting are proven.
- Graceful and forced stop semantics are proven.
- The operator's default profile fingerprint is unchanged.
- `just instance-control::integration`, `just check all`, and `just test full`
  pass with retained evidence paths.

## Non-goals

- UI click automation.
- Module lifecycle behavior from later phases.
- Remote control.
- Pushing commits to a remote.
