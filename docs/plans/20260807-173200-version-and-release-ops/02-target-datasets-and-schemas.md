# Target datasets and schemas

## Directory shape

```text
ops/
├── version/
│   ├── capability.yaml
│   ├── justfile
│   ├── current.yaml
│   ├── bin/
│   └── schema/
│       └── current.v1.schema.yaml
├── build/
│   ├── records/
│   │   └── <build-id>.yaml
│   └── schema/
│       ├── build-manifest.schema.yaml       # retained v1 contract
│       └── build-record.v2.schema.yaml
└── release/
    ├── capability.yaml
    ├── justfile
    ├── versions/
    │   └── v<semver>.yaml
    ├── bin/
    └── schema/
        └── release-record.v1.schema.yaml

builds/
└── <build-id>/
    ├── build.yaml
    └── <artifacts>
```

`ops/build/records/` contains durable promoted metadata, not artifacts.
`builds/` contains local artifacts and their portable metadata and remains
ignored.

## Product-version state

Illustrative `ops/version/current.yaml`:

```yaml
---
schema_version: 1
product_version: 0.5.0
updated_at: "2026-08-07T15:32:00Z"
```

The dataset is intentionally small. The implementation knows the current
mirror locations and how to edit them safely. Putting arbitrary paths,
selectors, commands, or version policies into YAML would turn a simple state
record into an unsafe configuration language.

`product_version` is derived exclusively from this repository's state and
release inventory. Original Shep tags and versions are neither consulted nor
reserved; a matching number in the former project has no operational meaning
here.

The authoritative mirror set at implementation time is:

- `package.json` `.version`;
- `src-tauri/tauri.conf.json` `.version`;
- `src-tauri/Cargo.toml` package version;
- `core/backend/Cargo.toml` package version;
- the generated matching entries in `Cargo.lock`.

Other workspace crates and packages currently use `0.0.0` intentionally and
are not product-version mirrors.

The schema accepts stable SemVer release versions only. Prerelease and build
metadata can be added later when there is a real channel that needs them; build
identity must not be hidden in SemVer build metadata now.

## Build identifier

Format:

```text
b<utc>-g<commit12>-<source-token>-<target>
```

Examples:

```text
b20260807T153200.123Z-g50d96e68b13a-t9d4587b65f21-aarch64-apple-darwin
b20260807T153215.901Z-g50d96e68b13a-w7f3a91c2d114-aarch64-apple-darwin
```

- `b...` is the UTC start time of this execution.
- `g...` is the commit at build start.
- `t...` is the clean Git tree fingerprint.
- `w...` is the dirty worktree fingerprint.
- the target prevents two platform outputs from appearing interchangeable.

The full hashes remain in the record; shortened tokens are only for names. The
identifier is generated before the build and the directory is created with
exclusive semantics. It is immutable after allocation.

For a dirty tree, calculate the fingerprint from a canonical byte stream:

1. full base commit;
2. `git diff --binary HEAD` covering staged and unstaged tracked changes;
3. sorted untracked, non-ignored path names and file bytes;
4. explicit separators and type markers so paths and contents cannot be
   concatenated ambiguously.

Generated and ignored directories such as `builds/`, `target/`, and `dist/` do
not enter the stream. The record must say `dirty: true`; a fingerprint makes a
dirty build distinguishable, not reproducible after those changes are lost.

## Build record version 2

Illustrative `build.yaml`:

```yaml
---
schema_version: 2
build_id: b20260807T153200.123Z-g50d96e68b13a-w7f3a91c2d114-aarch64-apple-darwin
created_at: "2026-08-07T15:32:00Z"
product_version: 0.5.0
target: aarch64-apple-darwin
mode: build
source:
  commit: 50d96e68b13a241a19ed40891fe2a37606088e00
  tree: 9d4587b65f2180ee8fe57c4232164710f82dc263
  dirty: true
  fingerprint_algorithm: sha256
  fingerprint: 7f3a91c2d114a9ef460102a49bd36d42e5d3d32a4db9f14031d976ab45ca64cd
command:
  - pnpm
  - tauri
  - build
  - --target
  - aarch64-apple-darwin
  - --bundles
  - app,dmg
  - --no-sign
toolchain:
  rustc: 1.x.y
  pnpm: x.y.z
  tauri_cli: 2.x.y
artifacts:
  - kind: app-bundle
    path: shep.app
    digest:
      algorithm: sha256
      scope: executable
      value: aaed18dc6321326f9a9ba38baa4b918dd64df16d58b9fd8da486b0f69a7218da
  - kind: dmg
    path: shep_0.5.0_aarch64.dmg
    size_bytes: 12345678
    digest:
      algorithm: sha256
      scope: file
      value: 04450d7a510e95509745243dbdf6320d58a5437d4f7fdd86ac7d4963b80a4613
provenance:
  status: verified
```

The final schema should require identity, time, product version, target, source,
command argv, artifact digests, and provenance. Toolchain fields are cheap to
collect and useful for diagnosis, but a missing optional tool version must not
block a local build.

Artifacts are an array rather than fixed `app` and `dmg` properties so a future
target can add a different package without changing the record shape. Digest
scope distinguishes a file hash from the executable hash currently used for an
app bundle.

The durable record is byte-for-byte the validated local `build.yaml`. Promotion
must refuse an existing filename with different bytes.

## Release record version 1

Illustrative `ops/release/versions/v0.6.0.yaml`:

```yaml
---
schema_version: 1
version: 0.6.0
status: candidate
created_at: "2026-08-07T16:00:00Z"
build_id: b20260807T155500.000Z-gabc123456789-tdef123456789-aarch64-apple-darwin
source:
  commit: abc123456789abcdef123456789abcdef12345678
  dirty: false
artifacts:
  - kind: dmg
    path: builds/b20260807T155500.000Z-gabc123456789-tdef123456789-aarch64-apple-darwin/shep_0.6.0_aarch64.dmg
    sha256: 6c34f0c778902cde40ae1c3b01e8537bf22b4e920cd90c06882a1322ca25177f
verification:
  fast_lane:
    status: passed
    command: just check fast
    completed_at: "2026-08-07T16:10:00Z"
  smoke:
    status: passed
    completed_at: "2026-08-07T16:16:00Z"
    note: App launched and primary session flow was checked.
signing:
  status: unsigned
distribution:
  channel: local-manual
  status: not-distributed
notes_path: docs/releases/v0.6.0.md
```

The release schema supports these lifecycle states:

- `planned`: the version is reserved, but no build is selected;
- `candidate`: one clean, durable build is selected and required verification
  has passed;
- `released`: the selected build is designated official;
- `withdrawn`: the official version should no longer be distributed.

Allowed transitions are checked by commands, not inferred from arbitrary YAML
edits. `released` means officially designated by this repository owner;
distribution remains an independent field. This works for local/manual
distribution now and does not pre-decide a future hosting service.

Release records duplicate the selected artifact hashes intentionally. The
record is a self-contained statement of what the version means. `release
verify` checks those values against the build record and any available files,
preventing the duplicate data from drifting silently.

## Schema evolution rules

- A schema filename includes its data contract version.
- A record's `schema_version` selects its schema.
- Published schema meaning is never changed in place.
- Validators reject unknown schema versions with a direct error.
- Old schemas stay available while old records exist.
- Adding optional fields that do not change meaning still requires a deliberate
  decision: retain the version only if old and new validators truly describe
  the same contract.
- A migration creates a new record version, validates it, and preserves the old
  file until the migration is explicitly accepted.

The existing JSON build manifest remains a valid historical version-1 format.
New YAML records start at version 2 rather than pretending the older contract
never existed.
