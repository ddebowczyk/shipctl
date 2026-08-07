# Capabilities and workflows

## Capability boundaries

### `version`

Owns:

- the official product-version state;
- SemVer validation and arithmetic;
- synchronized updates of known version mirrors;
- drift checking;
- build-ID and source-fingerprint generation as a reusable command.

Reads source-control state and product manifests. It does not build, commit,
tag, publish, or decide whether a change is patch, minor, or major.
It never reads or synchronizes former-upstream branches, tags, versions, or
release feeds. Fetching and comparing original Shep changes belongs to the
separate `upstream` capability.

### `build`

Continues to own compilation, packaging, local archives, artifact hashing, and
build records. It requires `version` for validated product state and build-ID
allocation. The existing `bump` and updater-metadata commands leave this
capability.

### `release`

Owns official-version records, candidate selection, release verification,
signing attestations, distribution metadata, and updater metadata derived from
an official record. It reads durable build records and requires `version` and
`build`. It does not compile source or own signing secrets.

Add `version` and `release` to `ops/ops.yaml` only when their manifests and
commands exist and pass the capability/schema checks.

## Command surface

The names below are the intended operator API; implementation can consolidate
them behind one script per capability.

### Version commands

```text
just version show
just version check
just version next patch
just version next minor
just version next major
just version set <semver>
```

`show` prints the state version, every mirror, and the highest inventoried
release. `check` fails on drift, malformed state, an invalid SemVer, or a state
version already contradicted by the release inventory.

`next` is a dry preview. It derives from the highest reserved or released
official version in this repository so an older working file cannot
accidentally move the line backward. It does not compare the original Shep
version line. The operator must supply the change class because code cannot
infer API compatibility or product meaning reliably.

`set`:

1. validates the requested SemVer and complete current state;
2. refuses a downgrade, duplicate inventoried version, or partial pre-existing
   drift;
3. writes proposed files to temporary siblings;
4. validates JSON, TOML, YAML, and Cargo metadata;
5. replaces all mirrors only after every proposed file passes;
6. prints the changed paths and stops.

It does not stage or commit. `bump-version.sh` is retired after equivalent
behavior exists under `ops/version/`.

### Build commands

```text
just build local [target]
just build archive [target]
just build list
just build show <build-id>
just build verify <build-id>
just build record <build-id>
```

`local` first runs `version check`, allocates the build ID, captures source
identity at build start, builds, hashes artifacts, writes YAML, and validates
the record. If source state changes during the build, it fails rather than
claiming mixed provenance.

`archive` replaces the current loose `--archive-only` behavior. It consumes a
provenance sidecar written by the build that produced the artifacts. The first
implementation should refuse artifacts without that evidence.

`list` scans local and durable records and reports product version, target,
clean/dirty source, provenance, and local artifact availability. `show` returns
one validated record. `verify` re-hashes available artifacts and checks record
identity. `record` promotes the exact YAML record into `ops/build/records/`
without modifying it.

Dirty builds remain useful for development and smoke checks, but `record` marks
them visibly and `release candidate` rejects them.

### Release commands

```text
just release plan <semver>
just release candidate <semver> <build-id>
just release verify <semver>
just release list
just release show <semver>
just release mark-released <semver>
just release withdraw <semver> <reason>
```

`plan` creates a validated record in `planned` state after ensuring the version
matches current product state and is not already inventoried.

`candidate` requires:

- a durable version-2 build record;
- exact product-version equality;
- clean source;
- verified build provenance;
- artifact hashes that still match available files;
- the fast check lane passing against the candidate source;
- one manual app smoke result for the exact candidate artifacts.

The smoke result may be entered from operator feedback; the command records the
attestation. It should not pretend the CLI observed a GUI check it did not
perform. Plugout tests are not run on every state transition. A broader release
suite may be attached later only when a concrete release risk requires it.

`verify` validates schema, transition coherence, build reference, source,
artifact hashes, and recorded attestations. It makes no external request.

`mark-released` changes the official lifecycle state after a successful verify.
It does not imply upload, Git tag, push, or updater publication. Distribution
metadata can be updated by a future explicit channel command.

`withdraw` requires a reason because the state is operationally meaningful. It
does not delete the record or artifacts.

## Normal workflow

### Routine local build

```text
version check
    -> allocate build ID
    -> build and archive
    -> validate builds/<id>/build.yaml
```

No product version changes and no tracked file is written.

### Prepare an official version

```text
version next patch|minor|major
    -> version set <chosen-version>
    -> release plan <chosen-version>
```

This updates local files only. A human can review and commit through the normal
repository workflow if and when desired.

### Select a release candidate

```text
build local
    -> build verify <id>
    -> build record <id>
    -> run fast lane once
    -> smoke exact app/DMG once
    -> release candidate <version> <id>
    -> release verify <version>
```

If signing or notarization changes the artifact bytes, that packaging result is
a new build ID. It becomes the candidate and receives the smoke check. The
unsigned precursor can remain as provenance but cannot stand in for the bytes
that will be distributed.

### Designate and distribute

```text
release mark-released <version>
    -> optional explicit manual-distribution record
```

External publication is absent from the initial implementation. When added, it
must consume the released record rather than independently recomputing version,
URLs, filenames, or hashes.

## Failure behavior

All mutating commands validate before replacing existing state and fail closed
on ambiguity. They never overwrite a different build record, reuse a released
version for changed bytes, accept a dirty official candidate, or infer success
from a missing artifact. Read-only commands should still show records whose
artifacts are unavailable, labeling availability rather than treating metadata
as invalid.
