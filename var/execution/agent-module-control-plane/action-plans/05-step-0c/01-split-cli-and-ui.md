# Split the CLI from the UI launcher

## Outcome

`shipctl`, `shipctl ui`, and the `shipctl-ui` launcher are distinct executable
roles with stable identities, while the packaged application continues to
launch the Tauri UI and carries the agent CLI beside it.

## Depends on

- Ratified Step 0A named-instance contract.
- Ratified Step 0B saved-state contract.
- The full Step 0C phase document.

## Production change

Add a workspace CLI crate whose binary is `shipctl`, rename the Tauri host
binary to `shipctl-ui`, make `shipctl` without a subcommand delegate to the UI,
and update Tauri/build packaging so both executables are produced together.
Keep UI executable discovery deterministic and local to the installed pair.

## Diagnostic or observability change

Both binaries report their executable role, build identity, and control
protocol version through machine-readable version output. Build diagnostics
identify both packaged executable paths.

## Mechanism-level integration test

Build the two real binaries, invoke each version surface, run the CLI through
an installed-pair layout, and inspect the resulting Tauri bundle metadata and
executables rather than substituting an in-process launcher mock.

## Acceptance evidence

- The workspace produces distinct `shipctl` and `shipctl-ui` binaries.
- Bare `shipctl` and `shipctl ui` resolve the paired UI executable.
- Packaged metadata names `shipctl-ui` as the Tauri main binary and includes
  `shipctl` as a sidecar.
- Existing build operations reference the renamed UI binary correctly.
- Unit, build, Markdown, and whitespace gates pass for this slice.

## Non-goals

- Implementing named-instance leases or discovery.
- Implementing the full agent command surface.
- Introducing a TCP or HTTP control server.
- Pushing commits to a remote.
