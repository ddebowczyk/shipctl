# Ratify the named-instance contract

## Outcome

The named-instance specification is complete enough to drive the first
implementation slice and is reconciled with the live single-binary,
home-relative application.

## Depends on

- Completed execution-contract phase at commit `1911d6e`.
- The full Step 0A phase document.

## Production change

Clarify prospective-root canonicalization, deterministic per-user runtime-root
resolution, and the live implementation baseline without changing the named
instance objective or introducing runtime code.

## Diagnostic or observability change

Record the current binary shape and every live Shipctl-owned home-relative
state seam that Step 0C must eliminate or explicitly classify.

## Mechanism-level integration test

Use syntax-aware outlines, exact searches, documentation retrieval, and
dependency-graph views against the live Rust shell and persistence owners.
Lint the amended specification and prove that its command, identity, root,
discovery, shutdown, diagnostic, and acceptance sections remain present.

## Acceptance evidence

- The public contract distinguishes `shipctl` from `shipctl-ui` and defines
  named start, list, inspect, and stop behavior.
- State-root and runtime-root selection are deterministic for production and
  isolated automation.
- Prospective roots and symlink aliases converge on one lease identity.
- The live baseline names the unparameterized managers, global cache, and
  Shipctl-owned home-relative stores that force Step 0C seams.
- Repo-local workspace state and external-provider home data remain outside
  instance-profile reclassification.
- Markdown lint and whitespace validation pass.

## Non-goals

- Implementing the executables, IPC protocol, leases, or path injection.
- Defining saved-state archive providers, which Step 0B owns.
- Pushing commits to a remote.
