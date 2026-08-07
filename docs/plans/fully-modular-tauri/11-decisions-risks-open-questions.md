# Decisions, risks, and open questions

## Recommended decisions

1. Treat runtime extensions as a Shep microkernel concern, not as dynamic Tauri
   plugins.
2. Keep PTY, workspace identity, credentials, and extension authority built in.
3. Make out-of-process execution the general extension model.
4. Add WASM as a constrained portable runtime after the process protocol works.
5. Make declarative host-rendered UI the default contribution model.
6. Restrict main-webview JavaScript extensions to exceptional trusted modules.
7. Keep extension code, persistent data, cache, and management state separate.
8. Require signatures and explicit capabilities for production activation.
9. Avoid extension-to-extension dependencies in the first protocol generation.
10. Require live codebase re-analysis before converting this roadmap into
    file-level implementation tasks.

## Primary risks

- Public API growth can force coordinated host and extension releases. Keep
  capability APIs narrow and protect them with compatibility fixtures.
- Event-bus proliferation obscures ordering, ownership, and recovery. Prefer
  commands, bounded streams, snapshots, and explicit lifecycle events.
- Package supply-chain compromise can expose host data or process authority.
  Require signatures, digests, trust policy, and least privilege.
- Incomplete deactivation leaves ghost UI, listeners, processes, and resource
  leaks. Use an instance-owned registration tree and forced cleanup.
- Native ABI loading can crash the host and conflict with OS signing. Prefer a
  process or WASM boundary.
- Rich UI authority can compromise the main frontend. Prefer declarative UI or
  an isolated webview.
- Cross-platform behavior may work in only one installer or sandbox. Maintain a
  release-target verification matrix.
- Extension-platform overgrowth can cost more than the product value it adds.
  Begin with two concrete pilots and gated phases.
- A shared JavaScript host lets one module crash or contaminate others. Use
  per-extension processes for stronger trust tiers.
- Irreversible data migrations prevent rollback. Keep versions side by side and
  require an explicit migration policy.

## Open product questions

- Are extensions first-party only, curated third-party, or open ecosystem?
- Must extensions work in Mac App Store, Microsoft Store, Flatpak, or only direct
  distribution builds?
- Can users install unsigned local development extensions?
- Which capabilities require installation-time consent versus per-operation
  consent?
- Can workspace configuration recommend extensions, and how is that displayed?
- Is extension enablement global, per project, per workspace, or a combination?
- Should removal preserve data by default?
- What is the compatibility-support window for old host API versions?
- Is one process per extension acceptable for memory usage?
- Which first two real modules justify package and runtime isolation?

## Open technical questions

- JSON-RPC, MessagePack, protobuf, or another process wire format?
- stdin/stdout versus authenticated local sockets for long-lived streams?
- Bundled Bun/Node host versus native executable per TypeScript extension?
- Which Wasmtime and Component Model versions should be pinned?
- How should process resource controls differ across macOS, Windows, and Linux?
- Can isolated rich views be embedded consistently on every supported platform?
- Which package signature format best supports offline verification and key
  rotation?
- Should registry durability use SQLite or an atomic structured file?
- How should extension data export and purge be represented in the UI?

## Stop conditions

Pause implementation and revise the architecture if:

- the pilot requires exposing arbitrary internal commands;
- safe deactivation requires restarting the complete application;
- an extension can access a workspace path outside its grant;
- protocol compatibility cannot be tested without the host implementation;
- installing a package modifies the signed application bundle;
- base startup or PTY operation depends on optional extension availability;
- the platform cannot explain which code is running and which capabilities it
  currently holds.
