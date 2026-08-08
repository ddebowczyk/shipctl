# Step 0C — named instance foundation implementation

## Outcome

Implement the Steps 0A and 0B contracts as the first vertical slice: packaged
binaries, production local IPC, injected filesystem roots, coherent state
snapshotting, and public black-box verification. No module lifecycle work may
create a second launcher, discovery mechanism, or test-only state model.

## Work package 0C.1 — split CLI and UI executables

- Add a small `shipctl` CLI crate or binary that owns parsing, output rendering,
  executable resolution, and control-client adapters.
- Rename the Tauri executable to `shipctl-ui` while preserving the app bundle
  identity and keeping `tauri::generate_context!()` beside `tauri.conf.json`.
- Package both executables and make `shipctl ui` resolve its matching UI binary
  on every supported platform.
- Keep domain behavior in `core/backend`; neither executable becomes a new
  capability layer.
- Add build-identity and protocol-version fields to both `--version` results and
  the launch handshake.

Diagnostic proof: a packaged test invokes both binaries, verifies matching
build identities, and proves a CLI listing command never initializes Tauri or a
webview.

## Work package 0C.2 — inject immutable instance paths

- Introduce `InstanceContext` with runtime UUID, name, canonical state root,
  canonical runtime root, build identity, and launch provenance.
- Derive a `ShipctlPaths` value from that context and inject it into
  `WorkspaceManager`, module installation, migrations, databases, and later
  services before setup begins.
- Replace the current process-global unkeyed config cache with a manager-owned
  cache bound to its `ShipctlPaths`.
- Move last-repository, theme, and other restorable UI persistence out of
  origin-wide local storage into the instance-owned state service.
- Route the assistant session registry and usage database through injected
  paths. Inventory every remaining home-relative state construction with a
  structural and text-search gate.
- Preserve repo-local `<repo>/.shipctl` semantics; do not reinterpret a project
  repository as the instance state root.

Diagnostic proof: `instances inspect` reports resolved paths and a source
inventory check fails if production code constructs an unapproved
home-relative Shipctl path.

## Work package 0C.3 — leases, discovery, and local control

- Acquire cross-platform exclusive name and writable-state-root leases before
  migration or restore.
- Publish descriptors atomically by UUID only after a same-user local endpoint
  is listening and initialization has reached ready.
- Use Unix-domain sockets on macOS/Linux and named pipes on Windows; apply
  current-user permissions and a versioned JSON frame protocol.
- Implement handshake-verified list and inspect operations plus conservative
  stale-descriptor reclamation.
- Implement application-controlled graceful and forced shutdown, including
  resource-blocker diagnostics and deterministic descriptor/lease cleanup.
- Inject exact `SHIPCTL_INSTANCE_ID` and control discovery context into PTYs
  created by that instance without coupling PTY lifetime to the socket.

Diagnostic proof: compiled-binary integration tests cover no instance, one
instance, two names and roots, stale descriptors, protocol mismatch,
duplicate-name races, duplicate-root races, graceful stop, blocked stop, and
explicit forced stop.

## Work package 0C.4 — agent-facing command behavior

- Implement the Step 0A and 0B command trees with non-interactive parsing.
- Keep JSON as the wire and assertion form; render default TOON only at the CLI
  edge using a pinned encoder and golden fixtures.
- Return structured success, no-op, conflict, blocker, and usage results with
  stable exit semantics.
- Resolve selectors by exact UUID or live name. Preserve exact UUID selection
  through `SHIPCTL_INSTANCE_ID`; never choose by focus, recency, or PID order.
- Make launch success depend on the ready event and matching handshake rather
  than sleep, polling delay assumptions, or process existence.

Diagnostic proof: black-box CLI tests assert machine output and exit status for
each public command, including ambiguous selection and an idempotent repeated
start and stop.

## Work package 0C.5 — snapshot provider and archive service

- Define versioned snapshot-provider, manifest, inclusion, exclusion, and
  fingerprint contracts in `core/backend`.
- Register providers for current host config, UI persistence, assistant
  restorable sessions, and usage storage. Use each store's coherent read or
  backup mechanism while the instance is running.
- Build and validate `.shipctl-state` archives without following symlinks or
  accepting absolute, parent-traversal, duplicate, or undeclared entries.
- Write a new restore into a staging directory, validate it, and atomically
  promote it to the requested empty state root before managers initialize.
- Implement `state save`, `state inspect`, and `state verify` through the same
  provider contracts used during restore.
- Emit exact included, reference-only, secret, and live-only provider evidence;
  never silently omit state.

Diagnostic proof: corrupt manifests, digest mismatches, incompatible schemas,
unsafe archive paths, unclassified sources, secret exclusions, non-empty
targets, interrupted creation, and provider failures all leave structured
evidence and no partial live instance.

## Work package 0C.6 — public automation gate

Add an `ops/instance-control/` driver that builds or locates the packaged pair
and performs the Step 0A and 0B scenarios entirely through public commands.
The harness allocates distinct temporary state roots and records their canonical
paths before launch. It observes ready and stopped protocol events instead of
fixed sleeps.

Planned entry points:

```text
just instance-control contract --output json
just instance-control integration --output json
```

The evidence bundle contains command requests, structured results, UUID/name
resolution, root identities, state fingerprints, snapshot provider results,
and cleanup status. It excludes snapshot payloads, credentials, ordinary
terminal output, and unrelated user instances.

## Exit proof

- `shipctl`, `shipctl-ui`, and `shipctl ui` work from the packaged installation.
- A test can start, list, inspect, and stop a named isolated instance without UI
  automation or private APIs.
- Two named instances with distinct roots are live and independently targeted.
- Name and state-root leases make racing starts deterministic and recover after
  verified process death.
- A saved state restores into a new root with the same restorable-state
  fingerprint, while runtime UUID, name, root, and live resources differ.
- The state manifest accounts for every current durable instance-owned source.
- Tests prove `~/.shipctl` and unrelated live descriptors were untouched.
- `just instance-control integration`, `just check all`, and `just test full`
  pass.

## Primary implementation areas

- workspace Cargo manifests and `src-tauri/` for the executable split;
- `core/backend/src/instance/` for context, leases, discovery, protocol, and
  shutdown;
- `core/backend/src/state/` for paths, providers, archive, and restore;
- current workspace, assistant, and usage owners for injected paths;
- `core/frontend/` for instance-owned UI persistence; and
- `ops/instance-control/` for packaged black-box tests and evidence.
