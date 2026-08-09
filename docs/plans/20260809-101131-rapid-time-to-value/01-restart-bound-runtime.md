# Work package 1 — restart-bound runtime

## Outcome

A validated, installed artifact selected as enabled is loaded once during
frontend startup and activated as a headless `ShipctlModule`. A configuration
change never restarts Shipctl; the next user-started instance reads the new
selection.

## Required delivery

- Add an offline desired-state operation that enables or disables an already
  admitted artifact. It records the selected immutable digest and returns the
  new registry revision plus `restartRequired: true`.
- Expose backend-approved startup descriptors for enabled artifacts: module id,
  version, digest, absolute entry path, canonical messages, capabilities, and
  any redacted load diagnostic. Never expose arbitrary filesystem traversal.
- Extend the generic artifact loader so an ESM factory returns a validated
  headless `ShipctlModule` using the host React singleton and module API.
- Before opening the frontend message bridge, load startup descriptors and
  compose successful runtime modules with the existing static module list for
  message registration and activation.
- Keep the core workspace running when a selected module cannot load. Report a
  stable, inspectable load failure and do not mutate desired state.

## Acceptance

- An added artifact remains inert while disabled.
- Enabling changes only desired durable state and states that a manual restart
  is required.
- A new named instance loads and activates the selected artifact exactly once.
- A malformed or failing entry does not publish its routes and does not prevent
  the static workspace from starting.
- Disabling takes effect only after the user restarts and then contributes no
  route or capability.
- No path rebuilds Rust, reloads a webview, invokes npm, or starts another
  Shipctl process.
