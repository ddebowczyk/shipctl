# Protocol, capabilities, and planes

## Protocol principle

The extension protocol is a public product API. It requires explicit semantic
versioning, compatibility fixtures, bounded messages, cancellation, timeouts,
and documented error behavior.

Prefer a small operation-oriented protocol over exposing generic object access.
For example:

```text
terminal.observe
terminal.snapshot
workspace.readFile
workspace.listFiles
extensionData.get
extensionData.put
ui.publishViewModel
```

Do not expose Rust types, database handles, Zustand stores, raw Tauri handles,
or direct access to application directories.

## Handshake

Activation begins with a handshake containing:

- extension identity and package digest;
- extension protocol version;
- requested host API version;
- runtime and SDK version;
- declared operation implementations;
- granted host capabilities;
- maximum supported message and stream features;
- instance and correlation identifiers.

The host must reject identity or capability claims that differ from the verified
manifest.

## Control plane

The control plane carries bounded request/response operations:

- activate, deactivate, cancel, health, and configure;
- register command and invoke command;
- open, close, and refresh an extension view;
- request a scoped PTY, workspace, or persistence operation.

Every request has an operation ID, deadline, caller identity, capability check,
and structured result. Cancellation must be explicit rather than inferred from
a dropped UI component.

## Data plane

The data plane carries high-volume or incremental information:

- PTY observations;
- file-change batches;
- progress and result streams;
- large query results;
- view-model deltas.

Streams need bounded buffers, sequence numbers, end/error frames, and defined
backpressure behavior. A slow extension must not block PTY readers or global
host services. Snapshot plus ordered delta should permit recovery after a gap.

## Management plane

The management plane owns:

- discovery, verification, installation, and compatibility;
- permission grants and revocation;
- active-version selection and rollback;
- process or WASM instance supervision;
- migrations, health, quarantine, and crash-loop protection;
- disable and uninstall operations.

Management operations are durable and auditable. They must not be represented
only as transient frontend state.

## Observability plane

Observability is not the domain-event bus. It records what happened without
becoming the authority for application state.

Minimum fields include:

- extension ID, version, digest, and instance ID;
- operation and correlation IDs;
- lifecycle transition;
- duration and result class;
- process exit status or WASM trap;
- queue depth, dropped frames, and protocol violations;
- granted capability used by an operation.

Sensitive arguments, terminal contents, credentials, and workspace data must be
redacted by policy.

## Capability model

Capabilities should describe meaningful host authority, not implementation
methods. Examples:

```text
terminal.observe
terminal.write
terminal.manage
workspace.read:<scope>
workspace.write:<scope>
network.connect:<host-pattern>
process.spawn:<command-id>
extension-data.read
extension-data.write
notifications.publish
```

Tauri capabilities continue to constrain built-in webviews and commands. The
dynamic extension broker needs an additional runtime permission store because
new extension identities and grants appear after the Tauri application has
already been packaged.

Paths, hosts, terminal IDs, and command IDs must be resolved and authorized by
the host. Passing a workspace root to an extension is not equivalent to granting
safe workspace access.
