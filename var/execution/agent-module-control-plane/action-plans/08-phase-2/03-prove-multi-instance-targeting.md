# Prove multi-instance online targeting

## Outcome

Compiled `shipctl` commands deterministically target named running instances,
including `SHIPCTL_INSTANCE_ID`, and fail rather than guessing when ambiguous.

## Dependencies

- Live registry control and frontend runtime snapshot publication.

## Production change

Add only test seams required to start isolated real `shipctl-ui` processes
through `shipctl ui`; keep ordinary production startup unchanged.

## Diagnostic/observability

Integration output records selected instance, build/protocol identity, registry
and observed revisions, runtime availability, and endpoint failure codes.

## Mechanism-level integration test

Start two named UIs with separate state roots and one runtime root. Prove
explicit name/UUID and injected environment targeting, ambiguous untargeted
failure, endpoint owner permissions, joined inspection, clean stop, offline
registry survival, and absence of TCP listeners.

## Acceptance evidence

- All Phase 2 exit-proof rows pass through compiled binaries.
- Step 0 lifecycle/isolation gates and repository gates stay green.

## Non-goals

- Rebuilding the host per module state or adding network control.
