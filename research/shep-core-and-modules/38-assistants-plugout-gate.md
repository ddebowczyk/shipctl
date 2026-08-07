# Assistants plug-out gate

Date: 2026-08-07

## Result

Assistants is now a removable vertical module. The frontend contribution and
native plugin can be disabled independently, and physically deleting
`modules/assistants/` from a disposable source copy leaves the remaining Shep
application buildable and testable.

The host retains generic panel persistence, terminal-session rails, module
lifecycle dispatch, and opaque workspace capability data. These contracts
remain useful without Assistants and contain no provider-specific behavior.

## Final host cleanup

The application menu now emits the capability-neutral `new_session` event and
labels the command **New Session**. Enabled modules may bind that event through
panel `newSession` metadata. If no module supplies a session launcher, the host
shows a generic unavailable notice instead of retaining a dead Assistant menu
path.

Persisted panel references are also capability-neutral. A saved
`assistants.launcher` tab whose source is no longer installed restores as an
unknown, retryable panel. The user can keep it for a later reinstall or close
it safely; restoration does not import or require the removed module.

## Verification harness

`scripts/verify-assistants-plugout.mjs` uses the shared disposable-copy harness
and validates three profiles. Destructive removal happens only beneath a
validated temporary directory.

<!-- markdownlint-disable MD013 -->

| Profile | Evidence | Result |
| --- | --- | --- |
| Enabled | Assistant provider and continuity characterization, module composition, panel persistence, terminal lifecycle, boundary and smoke tests, production frontend build, host and plugin Rust tests, native Tauri executable build | Pass |
| Frontend and native disabled | Assistant omitted from frontend composition and Cargo features; implementation absent from the browser bundle; generic host tests, production frontend build, native Tauri executable build | Pass |
| Source absent | Assistant package, crate, feature, profile, permissions, host adapter, characterization source, and `modules/assistants/` physically removed; pnpm and Cargo graphs checked; implementation-reference scan empty; generic host tests, production frontend build, host Rust tests, native Tauri executable build | Pass |

<!-- markdownlint-enable MD013 -->

Every profile receives its own Cargo target directory. Tauri-generated plugin
permission metadata contains absolute source paths, so sharing one target
between a live checkout and disposable copies could reuse stale paths and
produce a false failure after the temp copy was deleted.

## Commands

```bash
pnpm verify:assistants-plugout
pnpm verify:assistants-plugout -- --source-absent-only
pnpm check:module-boundaries
git diff --check
```

The source-absent-only form is useful while maintaining the deletion recipe.
The complete three-profile matrix is the commit gate.

## Removal contract

Physical removal deletes all Assistant-owned provider catalogs, launch UI,
logos, session-continuity logic, transcript identity capture, resume command
construction, native commands, permissions, tests, and module profiles.

It intentionally does not delete:

- host PTY and xterm infrastructure;
- generic module-terminal presentation and lifecycle ports;
- generic panel recovery and migration-alias support;
- opaque workspace capability data belonging to absent modules.

No Assistant provider DTO, command, icon, launch rule, session manifest type,
or implementation package remains in the source-absent dependency graphs or
browser bundle.

## Runtime scope

The automated gate compiles native executables but does not launch or install
them. The user's running Shep process and its PTY sessions remain untouched.

## Rollback

Reverting this gate restores only the former menu event name and removes the
combined deletion proof. Earlier frontend/native extraction commits remain
independent checkpoints.
