# Frontend module API

`@shipctl/module-api` is the compile-time contract between the Shipctl host and
frontend capability modules. It contains data-oriented contribution types and
host ports, not application stores or feature implementations.

The implementation tree makes the ownership direction explicit:

- `src/host/` contains host-provided ports and contexts that modules consume.
- `src/module/` contains module-provided contributions and callbacks that the
  host consumes.
- `src/protocol/` contains shared identifiers, DTOs, and parsers that neither
  side owns.

`src/index.ts` is the production package entrypoint and re-exports all three
categories. Production consumers must import `@shipctl/module-api`, never a
subpath. `@shipctl/module-api/testing` is a test-only entrypoint for the
DOM-free and Tauri-free semantic service host. The boundary checker rejects it
from module production source.

Allowed dependency direction:

```text
host composition ──> module public entrypoint ──> @shipctl/module-api
host internals ─────────────────────────────────> @shipctl/module-api
```

- The API package may import only platform-neutral types and React types.
- A module may depend on this package, but not on `src/`, another module's
  internals, `AppShell`, or host stores.
- Host composition may import a module's public entrypoint. Other host code may
  not import module implementation files.
- Modules receive narrow host ports; they are not given a generic store,
  command dispatcher, Tauri `invoke`, shell, or filesystem capability.
- Project capabilities can contribute optional facts, ordered layout surfaces,
  and either executable or lazy interactive project actions. Interactive
  actions receive only project registration and placement callbacks from the
  host.
- Terminal-owning capabilities launch sessions through a generic host port.
  The host owns PTY, xterm, tab placement, and focus mechanics; the module owns
  opaque session metadata, optional presentation, and policy for rename, move,
  stop, and pre-shutdown requests.
- A module that must prepare a native process before adoption can use the
  managed-launch callback. The callback receives only dimensions, environment,
  color theme, and an output sink; it returns a native terminal identity plus
  opaque metadata and presentation. Provider records remain invisible to core.
- Owner requests are awaited in registration order. A rejected request stops
  the host mutation, while process-started and process-exited notifications are
  best-effort because the process event cannot be rolled back.
- `beforeShutdown` hooks run sequentially before native PTYs are signalled. A
  failure aborts shutdown so a module can protect continuity data.
- Module activation owns runtime subscriptions, and project-lifecycle callbacks
  receive project paths after host state changes. Notices may include bounded
  actions so retry and recovery policy can stay inside the module.
- Every module activation receives one immutable activation identity and one
  typed semantic service lookup. Public services expose named operations,
  events, or ordered streams. They do not expose command strings or generic
  native dispatch.
- A rendered global surface receives its owning module's exact activation
  context. It cannot resolve services through another active module.
- Usage source access returns host-managed descriptors and redacted records.
  Provider paths and credential bytes stay behind the trusted platform
  adapter. The current overview projection is a named migration seam, not a
  generic native query escape hatch.
- Plugin Data exposes only admitted owner/scope/key records, schema versions,
  revisions, compare-and-write, and atomic migrations. Plugins never receive a
  filesystem path, file handle, database handle, or generic key-value store.
- Messages exposes directed send, scoped publish, and capability-port request
  as `shipctl.messages@1`. Message declarations remain passive module
  contributions. Bridge IDs, Tauri channels, command names, and raw transport
  errors stay behind the trusted adapter.
- Scheduler exposes typed target registration, activation-scoped inspection,
  and ordered delivery observations as `shipctl.scheduler@1`. A module declares
  schedule data and receives an owned lease. The host owns the clock, YAML
  source, route admission, cancellation, and activation cleanup. Raw browser
  timers are not part of this scheduling contract.

The host's boundary and profile tests enforce this dependency direction. A
capability may be disabled without requiring placeholder implementations in the
API package.
