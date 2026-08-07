# Runtime isolation models

## Decision summary

Use out-of-process extensions as the general runtime model and WebAssembly as a
constrained portable model. Do not use native dynamic libraries as the primary
extension ABI.

## Out-of-process extensions

An extension executable communicates with the host over a versioned protocol on
stdin/stdout or an authenticated local socket.

Benefits:

- process, dependency, allocator, and crash isolation;
- reliable stop and forced termination;
- implementation in Rust, Go, Bun, Node, Python, or another language;
- independent native dependencies and release cadence;
- no Rust ABI coupling to the Tauri host.

Costs:

- one or more platform-specific artifacts;
- process startup and memory overhead;
- separate code-signing and notarization requirements;
- explicit framing, backpressure, cancellation, and health protocols;
- OS sandboxing is not automatic merely because code runs in another process.

The host should control environment variables, current directory, inherited file
descriptors, arguments, executable path, and resource limits. It must not execute
an entrypoint path taken directly from an unverified manifest.

## TypeScript extension host

Shep may bundle one generic Bun- or Node-based extension host with the desktop
application. Independently installed extensions then contain bundled JavaScript
and resources rather than their own runtime.

Two execution modes are possible:

- one extension-host process per module gives stronger failure and dependency
  isolation;
- one shared extension-host process reduces memory but creates a shared crash,
  global-state, and dependency domain.

The first production design should prefer one process per untrusted or
independently managed extension. Module packages should contain a deterministic
bundled output, not run a package-manager install on the user's machine.

## WebAssembly components

Wasmtime can load components dynamically and expose only host functions defined
by WIT contracts. This is suitable for:

- data transformations;
- providers and parsers;
- rule evaluation;
- indexing and analysis;
- deterministic automation;
- modules needing strict filesystem and network scopes.

Benefits include portable binaries, explicit imports, memory isolation, and
host-controlled resources. Limitations include WASI ecosystem compatibility,
the need to broker native operations, runtime footprint, and an evolving
Component Model. Shep must pin its runtime, WIT worlds, and compatibility tests.

## Native dynamic libraries

Loading `.dylib`, `.so`, or `.dll` code into the Tauri process is not the
recommended model:

- Rust-to-Rust dynamic loading lacks a general stable ABI;
- a plugin panic, memory bug, or symbol conflict can terminate or corrupt Shep;
- unloading code with live callbacks, threads, or allocated objects is unsafe;
- macOS library validation and signing complicate arbitrary plugin loading;
- Windows search-path mistakes introduce DLL preloading risk.

If a future high-performance module requires native in-process loading, it must
use a minimal versioned C ABI, fully qualified verified paths, compatible
allocators, signed artifacts, and a rule forbidding host/plugin ownership from
crossing the ABI. This should remain an exceptional trusted tier.

## Runtime tiers

- Built-in Rust has the highest trust and owns PTY, workspace authority, and
  credentials.
- Separate executable or JavaScript-host processes have scoped trust and serve
  general extensions and integrations.
- Wasmtime components have constrained trust and serve providers, processors,
  and rules.
- Main-webview bundles have the highest frontend trust and are reserved for
  exceptional first-party UI.
