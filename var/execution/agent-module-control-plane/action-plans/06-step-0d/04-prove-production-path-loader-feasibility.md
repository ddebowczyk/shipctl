# 0D.4 Prove production-path loader feasibility

## Outcome

The packaged Tauri production path can load digest-qualified frontend ESM
artifacts A and B through the mediated host path, swap their evaluated markers
without a webview reload, preserve the host React singleton, and report a
structured failed-import phase while retaining the last good artifact.

## Dependencies

- 0D.1 injected module artifact and evidence paths.
- 0D.2 canonical module and verification contracts.

## Production change

Extend the existing modularity fixtures with two digest-qualified ESM
artifacts, packaged custom-protocol/CSP serving, mediated import, React
identity checks, marker swap, and failed-import retention. Classify trusted
frontend ESM as live-loadable, already compiled host adapters as callable but
not module artifacts, and new Rust/Tauri registration as restart/release-bound.
Unsupported worker/WASM runtime kinds must be rejected explicitly. Turning a
module on or off in the supported runtime path must not recompile Rust code.
Keep the Rust core generic and slow-changing; TypeScript module artifacts own
behavior, contributions, configuration, and diagnostics through stable core
APIs. Only a new native API requires a core release/restart.

## Diagnostic/observability

Emit one `VerificationResult` with fixture and schema identity, expected and
observed result, diagnostic phase/code, isolated paths, artifact URLs, exact
markers, content digests, React identity, and failed-import retention evidence.

## Mechanism integration test

Build the two fixture artifacts once, serve them through the packaged Tauri CSP
and custom-protocol path, import A then B in the same webview, verify the host
React singleton and marker change, then import failing C and verify A/B remains
evaluable with a structured diagnostic.

## Acceptance evidence

- A and B load through the production boundary, not a dev server.
- A and B report exact digest-qualified markers and share React.
- A and B swap evaluated markers in one already-running compiled host without
  webview reload, Cargo-feature change, or Rust rebuild.
- Failed C leaves the prior artifact usable and emits a stable diagnostic.
- Unsupported runtime kinds are rejected without false live-lifecycle claims.
- A failed proof blocks Phases 3–8 pending an explicit loader decision.

## Non-goals

- Module registry persistence or generic lifecycle commands.
- Live loading of new Rust/Tauri code.
- Implementing worker or WASM runtimes.
- Per-module disposable repository rebuilds.
