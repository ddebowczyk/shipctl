# Version and release operations plan

Status: proposed for implementation.

## Bottom line

Add two capabilities beside `ops/build/`:

- `ops/version/` owns the official product version and synchronizes every file
  that must carry it.
- `ops/release/` owns the inventory and lifecycle of official versions.

Keep `ops/build/` focused on producing artifacts. Every build receives an
immutable build identifier without changing the product version. An official
release selects an already-built artifact set by build identifier; it does not
silently rebuild it.

The resulting identities are deliberately separate:

| Identity | Example | Changes when |
| --- | --- | --- |
| Product version | `0.6.0` | An operator chooses a SemVer increase |
| Build identifier | `b<utc>-g<sha>-w<sha>-<target>` | Every build execution |
| Build schema version | `2` | The build-record data contract changes |
| Release schema version | `1` | The release-record data contract changes |

Builds do not consume patch versions, prerelease versions, or a shared build
counter. This keeps routine local work out of the official version namespace
and avoids a lock or mutable sequence file for concurrent builds.

## Contract

The capability is complete when:

- one command reports whether all product-version mirrors agree;
- one command previews and applies an explicit patch, minor, or major increase
  without committing or publishing anything;
- every archived build has a validated YAML record and a unique build ID;
- a dirty build records the content fingerprint that distinguishes it from
  other dirty builds at the same commit;
- one YAML file per official version records its selected build, artifact
  hashes, lifecycle state, verification, and distribution state;
- schema selection is driven by each record's `schema_version`, and historical
  schemas remain available;
- a release candidate refers to the exact tested build and fails verification
  if its artifacts have changed;
- the fast test lane and one smoke check are attached to the candidate build,
  not repeated at every metadata transition.

## Scope

This plan covers local version state, build identity and provenance, release
inventory, candidate selection, and verification. It does not push, tag, open a
PR, publish to GitHub, rotate signing keys, rename the product, or create a CI
release pipeline.

## Independent trunk and selective upstream intake

This repository is no longer maintained as a fork of the original Shep
codebase. It has diverged radically and permanently. Our `main` is the only
product trunk and will not be kept synchronized with the original repository.
We will not submit pull requests to the original repository because our local
architecture and product direction no longer form a useful contribution branch.

The original repository remains a read-only intake source. Keep its current
state in `upstream/main`, keep the reviewed watermark in `upstream-reviewed`,
and use `ops/upstream/` to fetch, compare, triage, and record selected changes.
Accepted behavior is implemented through local bd tasks and local module seams;
review never synchronizes, rebases, or wholesale-merges our product trunk.

Local version history and the local release inventory remain the complete
authority. `version`, `build`, and `release` do not derive state from original
Shep versions, tags, releases, or artifacts; read-only comparison belongs only
to `ops/upstream/`.

External publication remains a later adapter for this independent product and
must target infrastructure we own. It must never publish to or derive state
from the original Shep repository. The existing fork release identity plan
still governs updater trust, signing, endpoint, and product-name changes. This
plan gives that work reliable version and artifact inputs without trying to
solve it again.

## Decisions

1. `ops/version/current.yaml` is the source of operator intent for the official
   product version.
2. Known product-version mirrors are updated transactionally and checked for
   drift. The implementation owns the selectors; the YAML file does not become
   a generic file-editing language.
3. Every build gets `builds/<build-id>/build.yaml`. `builds/` remains ignored.
4. A build becomes durable only when promoted to
   `ops/build/records/<build-id>.yaml`. Release candidates require this durable
   record. Routine local builds therefore do not dirty the repository.
5. Official versions use one independently addressable file:
   `ops/release/versions/v<semver>.yaml`. There is no monolithic release ledger.
6. Build and release records are immutable in identity. Corrections use Git
   history; changed artifact bytes require a new build ID. Once a version is
   released, changed artifact bytes require a new product version.
7. Version commands never stage, commit, tag, push, or publish.
8. The former upstream has no authority over product state. It remains a
   read-only comparison feed for selective intake through `ops/upstream/`.
9. No workflow opens pull requests against the original Shep repository.

## Plan documents

- [Current state and problems](./01-current-state-and-problems.md)
- [Target datasets and schemas](./02-target-datasets-and-schemas.md)
- [Capabilities and workflows](./03-capabilities-and-workflows.md)
- [Implementation and proof](./04-implementation-and-proof.md)
