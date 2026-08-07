# Microkernel architecture

## Target shape

```text
┌──────────────────────── Signed Tauri host ────────────────────────┐
│                                                                  │
│  React shell and host-owned UI primitives                        │
│       │                                                          │
│  UI contribution registry                                       │
│       │                                                          │
│  Extension management plane                                     │
│   ├── package registry and verifier                              │
│   ├── compatibility resolver                                    │
│   ├── permission store and capability broker                     │
│   ├── lifecycle supervisor                                      │
│   ├── protocol gateway                                          │
│   └── observability                                             │
│       │                                                          │
│  Core services: PTY, workspace, storage, Git, configuration      │
└───────┼───────────────────────────┬──────────────────────────────┘
        │                           │
  versioned process RPC       versioned WIT interfaces
        │                           │
┌───────▼──────────┐       ┌────────▼─────────┐
│ Native/JS module │       │ WASM component   │
│ own resources    │       │ own resources    │
└──────────────────┘       └──────────────────┘
```

## Host responsibilities

The host owns only concerns that must remain stable, trusted, and globally
coordinated:

- extension discovery and package integrity;
- compatibility and permission decisions;
- activation, health, cancellation, and termination;
- routing between extension operations and host services;
- registration and removal of UI contributions;
- correlation IDs, structured logs, traces, and diagnostics;
- authoritative PTY, workspace, credential, and application state;
- recovery when an extension crashes, hangs, or violates protocol.

## Extension responsibilities

Each extension owns:

- its implementation and third-party dependencies;
- immutable resources delivered with the package;
- namespaced persistent data and disposable cache;
- migrations for data it owns;
- declared commands, views, settings, and event subscriptions;
- graceful shutdown of work it initiated;
- protocol-level error reporting and health information.

## Dependency rule

```text
extension implementation
        │
        ▼
extension SDK contracts
        │
        ▼
host protocol gateway
        │
        ▼
host application services
        │
        ▼
native infrastructure
```

No arrow may point from a public SDK contract to a Shep implementation module.
The host composition root may know concrete runners and services; extensions may
not.

## Built-in versus installable modules

Not every current Shep module should become an external extension. Security- and
integrity-critical primitives should initially remain built in:

- PTY process ownership and cleanup;
- workspace identity and path authorization;
- extension signature and permission enforcement;
- credential storage;
- update and migration coordination;
- the extension management system itself.

Higher-level providers, processors, integrations, reports, observers, commands,
and optional panels are better first extension candidates.

## Failure containment

The base application must remain healthy when an extension is absent, disabled,
incompatible, slow, crashed, or corrupt. Extension contributions should be
registered through instance-owned handles. Dropping those handles must remove
the complete visible and operational contribution set.
