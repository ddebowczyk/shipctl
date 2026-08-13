---
name: versioning
description: Change, inspect, and verify the Shipctl product version and its release tag.
---

# Shipctl versioning

`ops/version/current.yaml` is the only product-version authority. The Tauri
configuration is its packaging projection. npm and Cargo manifests keep the
placeholder version `0.0.0`.

Git tags are the local release ledger. A stable release tag has the form
`v<major>.<minor>.<patch>`. The product version cannot move backwards from the
highest ledger tag.

There is no separate release-channel field. A release becomes real only when
its annotated Git tag names the committed product version.

## Inspect

Before a release, synchronize the tag ledger and inspect the state:

```bash
just version sync
just version show
just version check
```

`show` prints the source version, packaging projection, highest local release
tag, and their relation. `check` fails if the record, the projection, or the
release ordering is invalid.

## Select and set a version

Do not edit version files by hand. Preview the next value from the newer of
the current source version and the highest release tag:

```bash
just version next patch
just version next minor
just version next major
```

Set the chosen stable version with:

```bash
just version set <major.minor.patch>
just version check
```

`set` changes only `ops/version/current.yaml` and
`src-tauri/tauri.conf.json`. It rejects a current-version rollback and a value
that is not newer than the release ledger. It does not stage, commit, tag, or
publish files.

## Verify a release tag

After all release checks pass, commit the version change and create an
annotated tag:

```bash
git add ops/version/current.yaml src-tauri/tauri.conf.json
git commit -m "Release v<major.minor.patch>"
git push origin main
git tag -a v<major.minor.patch> -m "Shipctl v<major.minor.patch>"
git push origin v<major.minor.patch>
just version verify-release
```

`verify-release` proves that the current version has an annotated tag, the tag
points to `HEAD`, the source tree is clean, and no later stable local release
tag exists. Build the release artifact only after this check passes.
