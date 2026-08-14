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

`src/index.ts` is the only public package entrypoint and re-exports all three
categories. Consumers must import `@shipctl/module-api`, never a subpath.

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

The host's boundary and profile tests enforce this dependency direction. A
capability may be disabled without requiring placeholder implementations in the
API package.
