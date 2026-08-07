# Shep integration and extension SDK

## Existing foundations

Shep already has useful composition seams:

- Tauri-managed Rust components for PTY, workspace, assistant sessions, usage,
  and watchers;
- a frontend panel registry and panel host;
- module-composition checks;
- Zustand stores for host-owned frontend read models;
- Tauri commands and events connecting the native and frontend layers.

These should be evolved into host services and adapters. They should not be
exposed directly as the extension API.

## Proposed Rust host modules

```text
src-tauri/src/extensions/
├── mod.rs
├── manifest.rs
├── package.rs
├── registry.rs
├── verifier.rs
├── compatibility.rs
├── permissions.rs
├── protocol.rs
├── contributions.rs
├── lifecycle.rs
├── supervisor.rs
├── process_runner.rs
├── wasm_runner.rs
├── data.rs
└── telemetry.rs
```

The first composition root should construct one `ExtensionManager` from narrow
services rather than place all behavior in a global manager class. The public
Tauri commands should be thin management-plane adapters such as list, inspect,
install, enable, disable, upgrade, remove, and diagnose.

## Proposed frontend modules

```text
src/core/extensions/
├── api.ts
├── contracts.ts
├── controller.ts
├── eventBridge.ts
├── contributionRegistry.ts
├── viewRenderer.tsx
└── store.ts
```

The extension controller listens once to host lifecycle events and projects
authoritative state into frontend read models. React components should not each
register raw Tauri listeners. Extension UI must not import unrelated host
stores.

## Extension SDK

A separately versioned `shep-extension-sdk` should contain only public material:

- canonical manifest schema;
- process protocol and generated bindings;
- WIT worlds and generated WASM bindings;
- contribution schemas and TypeScript types;
- capability vocabulary;
- lifecycle and error contracts;
- package validation and signing tools;
- local development host and fixtures;
- compatibility test suite;
- sample minimal extensions.

The SDK must not contain copied Shep implementation code.

## Developer workflow

A module author should be able to run:

```text
shep-ext init
shep-ext validate
shep-ext test
shep-ext pack
shep-ext sign
shep-ext install --dev ./dist/module.shep-extension
```

The exact CLI is provisional, but the workflow should be reproducible without
checking out the main Shep repository.

## PTY boundary example

The built-in PTY service remains authoritative. An extension can request scoped
operations such as observing output or reading a completed-session projection.
It should not receive `portable_pty` handles, process objects, unrestricted
shell access, or the internal PTY registry.

```text
extension
  → terminal.observe(session-id)
  → capability check
  → terminal application service
  → bounded sequenced stream
```

Extensions requiring terminal management receive a separate stronger
capability from extensions that only observe lifecycle or output.

## Architecture tests

Add executable checks proving that:

- SDK packages do not import host implementation modules;
- built-in domain services do not import extension runners;
- frontend extensions do not import arbitrary Zustand stores;
- extension protocol DTOs remain serialization-compatible;
- package fixtures cannot escape their extraction root;
- disabling an extension removes every registered contribution;
- the base application starts with no extension directory present.
