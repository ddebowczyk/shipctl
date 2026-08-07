# References

## Tauri

- [Plugin development](https://v2.tauri.app/develop/plugins/) explains that a
  Tauri plugin is a Cargo crate with an optional NPM API package and lifecycle
  hooks. This is a build-time extension mechanism rather than the proposed
  post-install package model.
- [Embedding external binaries](https://v2.tauri.app/develop/sidecar/) documents
  Tauri sidecars, target-specific external binaries, and compile-time bundle and
  permission declarations.
- [Calling Rust from the frontend](https://v2.tauri.app/develop/calling-rust/)
  documents commands, channels, and events. Channels are the relevant primitive
  for streamed frontend data.
- [State management](https://v2.tauri.app/develop/state-management/) documents
  Tauri-managed host state and lifecycle access.
- [Capabilities](https://v2.tauri.app/security/capabilities/) documents
  permissions by window or webview and the limits of that boundary.
- [Content Security Policy](https://v2.tauri.app/security/csp/) recommends a
  restrictive CSP and warns against untrusted remote scripts and content.

## Runtime and protocol

- [Wasmtime introduction](https://docs.wasmtime.dev/) describes Wasmtime as a
  runtime for WebAssembly, WASI, and the Component Model.
- [Wasmtime application with plugins](https://docs.wasmtime.dev/wasip2-plugins.html)
  demonstrates directory discovery, WIT contracts, and runtime component
  loading.
- [Wasmtime security](https://docs.wasmtime.dev/security.html) describes the
  sandbox and capability-oriented WASI filesystem access.
- [Wasmtime proposal status](https://docs.wasmtime.dev/stability-wasm-proposals.html)
  records Component Model maturity and implementation status.
- [Tokio synchronization](https://docs.rs/tokio/latest/tokio/sync/index.html)
  documents bounded message channels, backpressure, broadcast, watch, and
  request-response composition.

## Operating systems

- [Apple Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime)
  documents code-injection protections, library validation, and exceptional
  entitlements for arbitrary plugins.
- [Apple code-signing library validation](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html)
  explains signature-team requirements for dynamically linked libraries.
- [Windows dynamic-link library security](https://learn.microsoft.com/en-us/windows/win32/dlls/dynamic-link-library-security)
  describes DLL preloading and safe path-resolution considerations.
- [Windows code-signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
  summarizes signing choices for Store and direct desktop distribution.

## Repository evidence to recheck

The implementation plan should be re-baselined against these live seams before
subtasks are created:

- `src-tauri/src/lib.rs`: Tauri composition root and managed state;
- `src-tauri/src/pty/`: authoritative PTY ownership;
- `src-tauri/src/workspace/`: workspace configuration and management;
- `src-tauri/src/usage/`: SQLite-backed usage subsystem;
- `src/core/modules/`: frontend panel registry and module composition;
- `src/stores/`: host-owned frontend read models;
- `src/lib/tauri.ts`: current frontend/native boundary;
- `src-tauri/capabilities/`: current static Tauri authority.
