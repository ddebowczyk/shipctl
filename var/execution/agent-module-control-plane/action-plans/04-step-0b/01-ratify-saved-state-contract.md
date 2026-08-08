# Ratify the saved-state contract

## Outcome

The saved-state specification defines a complete, verifiable contract for a
coherent multi-provider snapshot and identity-independent restore.

## Depends on

- Completed Step 0A phase at commit `d805d53`.
- The full Step 0B phase document.

## Production change

Clarify entry-level state classification, the cross-provider durable-write
barrier, canonical restorable-state fingerprinting, and the live durable-source
baseline without implementing the archive service.

## Diagnostic or observability change

Make partial capture, unclassified state, excluded data, source provenance, and
restored-state equivalence distinguishable in the manifest and inspection
contract.

## Mechanism-level integration test

Outline and search the live host config, frontend persistence, assistant
manifest, and usage database owners. Retrieve their prior architecture context
and inspect dependency-graph trails. Lint the amended specification and verify
that every current instance-owned durable source is explicitly classified.

## Acceptance evidence

- A provider can classify individual entries instead of forcing mixed config
  into one portability class.
- The save coordinator cannot publish an archive assembled from inconsistent
  provider epochs or partial provider success.
- Fingerprint inputs are canonical and exclude new-instance identity and
  capture provenance.
- Host config, UI persistence, assistant restore metadata, and usage storage
  are accounted for; repo content, credentials, caches, IPC, and PTYs are not
  copied.
- Restore validation and staging leave no partial target profile on failure.
- Markdown lint and whitespace validation pass.

## Non-goals

- Choosing an archive container implementation.
- Implementing snapshot providers or moving persistence paths.
- Copying credentials, repository contents, or live processes.
- Pushing commits to a remote.
