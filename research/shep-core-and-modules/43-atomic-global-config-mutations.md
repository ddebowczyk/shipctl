# Atomic global config mutations

Date: 2026-08-07

## Outcome

Every in-process read-modify-write operation on `~/.shep/config.yml` now uses
one generic transaction boundary. The same process-wide mutex remains held
while the current document is loaded, a closure mutates it, the complete YAML
document is written, and the cache is updated.

This removes the lost-update window between host settings and module-owned
global capability data without introducing capability names or schemas into the
storage layer.

## Previous failure mode

The cache mutex previously protected individual cache reads and writes only. Two
callers could therefore both load snapshot A, independently change different
fields, and save snapshots B and C. The later save replaced the complete YAML
document and silently discarded the earlier caller's field.

That race affected editor, project, keybinding, terminal, Usage, repository,
group, and generic module-data setters because each performed a separate
`load_global_config()` followed by `save_global_config()`.

## Transaction boundary

`mutate_global_config` is capability-neutral. It accepts a closure over
`GlobalConfig` and delegates to a path-injectable internal implementation used
by tests. The transaction performs these steps under one lock:

1. resolve the newest cached or on-disk document by modification time;
2. run the caller's mutation closure;
3. abort without writing if the closure returns an error;
4. serialize and write the complete human-editable YAML document;
5. update the cache from the committed document and its new modification time.

All existing setters that modify an existing global document now use this
boundary. Whole-document creation remains limited to first-run defaults and the
one-time legacy migration, both guarded by an absent-config precondition.

Unknown top-level capability values continue to round-trip through the flattened
map. The transaction has no knowledge of Usage or any other module.

## Deterministic concurrency proof

The Rust test uses a private temporary config path and cache. Writer A changes a
host-owned editor field and pauses inside the mutation closure while holding the
transaction lock. Writer B announces its attempt to update module-owned data
but is proven unable to enter its closure until writer A is released.

After both commits, the test reloads the YAML and verifies all three independent
values:

- writer A's host-owned editor setting;
- writer B's module-owned capability value;
- a pre-existing unknown human-editable capability value.

This makes the former stale-snapshot interleaving deterministic rather than
depending on probabilistic thread timing.

## Scope limit

The mutex coordinates threads inside one Shep process. It is not an operating
system file lock and does not serialize two independently running Shep processes
or an external editor writing at exactly the same time. That broader durability
problem is a separate follow-up; it does not block removing typed Usage settings
ownership because host and module calls in one running app now share the atomic
boundary.

## Verification

The following checks passed:

```sh
CARGO_TARGET_DIR=src-tauri/target/config-atomic cargo test -p shep -- --test-threads=1
pnpm test:usage-characterization
pnpm exec tsc --noEmit
pnpm test:module-boundaries
pnpm test:module-composition
git diff --check
```

The dedicated Cargo target avoids stale Tauri generated metadata left by prior
disposable source-removal worktrees.
