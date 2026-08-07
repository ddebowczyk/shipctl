# Implementation and proof

## Work order

### 1. Establish version authority

- Add `ops/version/capability.yaml`, `justfile`, `current.yaml`, and the
  version-1 schema.
- Implement `show` and `check` against all live product-version mirrors,
  including `core/backend/Cargo.toml` and generated Cargo lock entries.
- Implement explicit SemVer preview and transactional `set`.
- Remove commit/stage behavior from the workflow and retire the build-owned
  bump command only after parity is proven.
- Register the capability in `ops/ops.yaml` and root `justfile`.

Proof:

- current `0.5.0` state validates and all mirrors agree;
- a temporary fixture with one divergent mirror fails and names that mirror;
- patch, minor, and major previews produce the expected SemVer arithmetic;
- an invalid version, downgrade, or already-inventoried version changes no
  files;
- a successful fixture update changes every mirror and leaves Git untouched.
- version calculation performs no former-upstream fetch, lookup, comparison, or
  synchronization.

### 2. Upgrade build identity and records

- Add build-ID/source-fingerprint generation under `version`.
- Add the immutable build-record version-2 schema while retaining the current
  version-1 schema.
- Change local archives from JSON `build.json` to validated YAML `build.yaml`.
- Capture argv, target, source identity, useful toolchain versions, artifact
  size and digest scope, and provenance status.
- Detect source changes during a build.
- Replace unconstrained archive-only behavior with sidecar-bound archive
  provenance.
- Add `list`, `show`, `verify`, and `record` commands.

Proof:

- two builds of the same clean commit have distinct build IDs and the same
  source fingerprint;
- two dirty states at the same commit have different source fingerprints;
- ignored build output does not alter the fingerprint;
- a modified artifact fails verification;
- promotion produces a byte-identical durable record and refuses conflicting
  existing content;
- a version-1 historical manifest still validates with its original schema;
- missing archive-only provenance is rejected.

### 3. Add release inventory

- Add `ops/release/capability.yaml`, `justfile`, version-1 release schema, and
  one-file-per-version storage.
- Implement `plan`, `candidate`, `verify`, `list`, `show`, `mark-released`, and
  `withdraw`.
- Enforce lifecycle transitions and exact build/version/hash linkage.
- Record fast-lane and user-provided smoke attestations on the selected build.
- Register the capability and teach the schema check to discover all version,
  durable build, and release datasets by `schema_version`.

Proof:

- a planned version cannot become a candidate with a dirty, missing,
  unrecorded, wrong-version, or hash-mismatched build;
- an exact clean build with the required attestations can become a candidate;
- changing the selected build invalidates earlier attestations;
- `released` can only follow a successful candidate verification;
- release listing works when local artifacts were cleaned and reports them as
  unavailable;
- every checked-in YAML dataset passes `ys`, `yamllint`, and the fast schema
  aggregate.

### 4. Make release packaging consume the records

- Move updater metadata ownership from `build` to `release`.
- Make signed/notarized packaging produce a build record for the resulting
  bytes rather than mutating an earlier unsigned record.
- Generate filenames, product version, hashes, and updater data from the
  selected records.
- Remove tag/push/GitHub instructions from core commands. If publication is
  added later, expose it as a separate explicit operation.

Proof:

- generated metadata names the selected version and exact artifact hash;
- no release command reads a product version independently from the version
  state and selected build record;
- no command stages, commits, tags, pushes, opens a PR, or publishes;
- one fast-lane run and one user-confirmed smoke of the final candidate are
  sufficient for the local release workflow.

## Fast verification during implementation

Use the smallest proof attached to the changed capability:

- schema or dataset change: `ys` for the affected pair plus `yamllint`;
- version logic change: focused version fixtures and `version check`;
- build-record logic change: focused record/fingerprint tests and one archive
  fixture;
- release transition change: focused release-record fixtures;
- capability registration or command surface change: the existing fast schema
  and ops checks.

Do not run plugout or a full signed release after every step. Run the repository
fast lane when the capabilities are integrated. Perform an actual app build and
manual smoke only on the candidate path whose artifact behavior changed.

## Cheap initial implementation choices

- Use the existing Node, shell, `yq`/`jq`, `ys`, and Git toolchain; add no
  service or database.
- Use Git history as the audit trail for tracked records.
- Keep local artifact storage under the existing ignored `builds/` directory.
- Scan directories to produce inventories; no generated index file is needed.
- Store UTC timestamps and full hashes in data, short hashes only in names.
- Refuse provenance that cannot be established instead of building a repair
  framework.
- Support the existing macOS target first while keeping artifacts target-aware.
- Record manual smoke feedback as an explicit attestation rather than adding UI
  automation.
- Keep signing and external distribution optional in the schema until the fork
  trust and channel decisions are implemented.

## Tripwires

Stop and correct the design if implementation starts to:

- bump SemVer for every build;
- introduce a global build counter or lock;
- stage, commit, tag, push, or publish implicitly;
- use original Shep branches, tags, versions, releases, or artifacts as
  version, build, or release authority rather than read-only intake evidence;
- rebuild after candidate verification without allocating a new build ID;
- store secrets in a record;
- rewrite a historical schema in place;
- require local artifact presence merely to list historical releases;
- turn release inventory into a test-orchestration framework;
- duplicate the updater trust, signing, or product-identity decisions from the
  existing fork release plan.

## Completion state

The work halts when the contract in the plan index is proven. Hosted release
publication, CI, retention automation, changelog intelligence, extra platform
targets, and schema migration tooling remain outside this epic until an actual
workflow requires them.
