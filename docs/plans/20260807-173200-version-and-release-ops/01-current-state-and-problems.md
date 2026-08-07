# Current state and problems

## What exists now

The repository already has the useful beginning of a build inventory:

- `just build local` archives unsigned app and DMG artifacts under `builds/`;
- archive directories include UTC time, target, commit prefix, and clean/dirty
  state;
- each archive contains a JSON `build.json` with product version, commit,
  command, and artifact checksums;
- `ops/build/schema/build-manifest.schema.yaml` validates that manifest with
  `schema_version: 1`;
- six local manifests currently demonstrate the format in use.

The product version is currently `0.5.0` in:

- `package.json`;
- `src-tauri/tauri.conf.json`;
- `src-tauri/Cargo.toml`;
- `core/backend/Cargo.toml`;
- the corresponding `shep` and `shep-core` entries in `Cargo.lock`.

The existing bump script updates only the first three source files. It also
stages and commits the change, which couples version mutation to Git policy and
does not fit local-only operation.

`ops/build/bin/release-build.sh` builds signed artifacts and prints manual
tag/push/release instructions. It does not create a durable release record or
bind the release to the exact build that was tested. `generate-update-json.sh`
derives updater data independently and still assumes an external publication
destination.

The general schema check currently discovers capability manifests, module
manifests, and selected upstream datasets. New version, build-record, and
release datasets need explicit discovery and schema dispatch.

The repository has permanently left the original Shep development line. The
existing upstream datasets support a live read-only intake workflow: fetch and
compare original changes, triage them, and turn selected behavior into local bd
work. They do not make the original repository authoritative over product or
release state.

## Problems we will hit

### Build identity is descriptive but not sufficient

Two dirty builds at the same commit are currently distinguished only by their
timestamps. Their source content can be different while both say merely
`git_dirty: true`. The record cannot answer whether two builds used the same
source state.

**Solution:** record a source fingerprint. For a clean tree, use the Git tree
identity. For a dirty tree, hash the base commit, binary tracked diff, and the
sorted paths and contents of untracked non-ignored files. Keep the execution
timestamp in the build ID for sorting, but use the fingerprint for content
comparison.

### A build number should not consume an official version

Automatically changing `0.5.0` to `0.5.1` for routine builds would create
meaningless official versions and make candidate comparison harder.

**Solution:** allocate a build ID automatically for every build. Change SemVer
only through an explicit `version next patch|minor|major` or `version set`
operation. The tool automates arithmetic and synchronization, not the semantic
choice between patch, minor, and major.

### Version mirrors can drift

Tauri, npm, and Cargo all need the product version in their own files. A single
unchecked edit can produce an app whose visible version, package metadata, and
release metadata disagree.

**Solution:** make `ops/version/current.yaml` the operator-intent record, update
all known mirrors as one transaction, regenerate the relevant lockfile entries
through Cargo, and make `version check` a fast prerequisite of build and release
commands.

### A shared build counter creates coordination work

A committed integer incremented by every build would dirty the tree, collide
under concurrent builds, and create merge conflicts without adding meaningful
provenance.

**Solution:** no global counter. Use UTC execution time, commit, source
fingerprint, and target in the build ID. Create the archive directory
exclusively and regenerate the timestamp if that exact ID already exists.

### `archive-only` can mislabel old output

The current mode can archive artifacts from `target/` while describing the
repository's current commit and dirty flag. If the source tree changed after
the artifacts were built, the manifest is false.

**Solution:** a successful build writes a small provenance sidecar beside its
output. `archive-only` must consume that sidecar. If it is missing or the
artifacts no longer match its hashes, the archive is marked unverified and
cannot become a release candidate. The simplest first implementation may
refuse instead of producing an unverified archive.

### Tested and shipped artifacts can diverge

Rebuilding after a smoke check can produce different bytes because dependencies,
toolchains, generated files, signing, or the working tree changed.

**Solution:** candidate selection promotes an existing build ID and copies its
artifact hashes into the release record. Release verification re-hashes those
same artifacts. Packaging or signing that changes bytes produces a new build
record, which is the record selected for the candidate and smoke checked.

### Ignored artifacts disappear

`builds/` is correctly ignored because app bundles and DMGs do not belong in
Git, but deleting it also deletes the only current manifest.

**Solution:** keep every local `build.yaml` with its artifacts and add an
explicit `build record <id>` promotion that copies the validated metadata to
`ops/build/records/`. Release candidates require the durable record. Artifact
availability remains explicit and may become `missing`; metadata and hashes do
not disappear with local cleanup.

### One inventory file will become contentious

A single YAML array for all builds or versions requires rewriting a shared file
for every addition and makes review and conflict resolution needlessly broad.

**Solution:** one file per build record and one file per official version. List
commands derive an inventory by scanning and validating files.

### Schema changes can invalidate history

Changing a schema in place makes old records ambiguous: they may stop
validating or silently acquire new meaning.

**Solution:** record `schema_version`, keep immutable versioned schema files,
and dispatch validation by that field. The existing build manifest is version
1; the expanded YAML build record starts at version 2. Migration is an explicit
command only when it becomes necessary.

### Release state and publication state are different

The original Shep repository is no longer our product trunk. We fetch it into a
read-only comparison branch but do not keep local `main` synchronized with it,
submit pull requests back to it, reuse its version ordering, or publish releases
through it. Current updater/signing decisions for our independent product are
unresolved. Treating "official" as synonymous with "published on GitHub" would
block useful local release management.

**Solution:** release lifecycle records whether the owner designated a build as
the official version. Distribution is a separate nested state with channel,
location, and time. The initial supported channel is local/manual. Publication
automation is deferred and, when implemented, must use infrastructure owned by
this product rather than the former upstream.

### Secrets and attestations can be confused

Signing keys must not enter YAML, but release verification still needs to say
what was signed and notarized.

**Solution:** records may contain public key identifiers, signature file paths,
checksums, notarization IDs, and pass/fail attestations. They never contain a
private key, password, token, or `.env` value.

### Metadata edits can masquerade as a replacement release

It is tempting to replace a DMG under the same version after discovering a
packaging error.

**Solution:** hashes are part of both build and release records. Before release,
changed bytes create a new build ID and reset candidate verification. After
release, changed bytes require a new product version. Documentation-only record
corrections use normal Git history.

## Problems deliberately deferred

- CI orchestration and a platform build matrix;
- hosted artifact retention and garbage collection policy;
- automatic changelog generation from commits;
- signing-key custody and rotation;
- updater-channel publication;
- dependency or workspace package versioning independent of the desktop app;
- a database or event-sourced release service.

The schemas should leave room for other targets and distribution channels, but
the implementation should support only workflows that exist now.
