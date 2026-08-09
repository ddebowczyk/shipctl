# Work package 4 — release proof and return path

## Outcome

A teammate can run the demonstrator from packaged artifacts and reproduce the
value without source-level registry mutation or test-only hooks.

## Required delivery

- Add a public-boundary integration proof that:
  1. creates an isolated state and runtime root;
  2. builds, preflights, adds, and enables the demo artifact with the built CLI;
  3. starts the built app as a named instance;
  4. discovers, inspects, and invokes the capability with the built CLI;
  5. proves message, topic, and terminal-output observations;
  6. proves no event or terminal-byte persistence; and
  7. disables the module, manually restarts, and proves it is absent.
- Produce the normal unsigned macOS app, CLI, and DMG with the repository build
  pipeline. Include the demo archive and a concise `DEMO.md` beside them under
  the same `builds/<build-id>/` directory.
- Verify the build manifest and record exact artifact hashes and proof results.
- Update the broader module-control execution documents and Beads only with
  conclusions demonstrated by this release. Leave live replacement and further
  phases stopped for owner reassessment.

## Acceptance

- The release proof uses no direct SQLite mutation, frontend test import,
  private loader probe, or source-tree application binary.
- `just build local` and build verification succeed.
- The build directory contains the app, CLI, DMG, demo archive, build manifest,
  demo instructions, and proof evidence.
- A clean failure path shows that restoring the previous state or disabling the
  module followed by a manual restart returns to the prior working workspace.
- The separate detour epic and every child task are closed only after the built
  proof passes.
