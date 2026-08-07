# Delivery roadmap

## Gate 0: re-baseline the refactored codebase

Before creating implementation subtasks, re-analyze the live Rust composition
root, frontend module composition, Tauri capabilities, package scripts, and
active refactor branches. Confirm ownership of PTY, workspace, persistence,
events, and panel registration.

Do not derive file-level tasks solely from this document: the repository is
being refactored and paths or boundaries may have changed.

## Phase 1: contracts and threat model

- identify two real extension candidates with different needs;
- define extension identity, manifest schema, and package digest model;
- define capability vocabulary and authorization ownership;
- choose process framing and protocol serialization;
- define lifecycle state machine and structured errors;
- produce a threat model for package install, activation, UI, and removal;
- write compatibility and malicious-package fixtures before runtime loading.

Exit gate: contracts can describe both pilot extensions without exposing an
internal Shep type.

## Phase 2: inert package management

- implement safe archive validation and extraction;
- implement signatures, trusted publishers, and development trust;
- add immutable version directories and transactional registry;
- implement list, inspect, install, and remove for non-executable fixtures;
- add interruption recovery and staging cleanup;
- expose management state to a minimal host-owned UI.

Exit gate: packages can be installed, inspected, upgraded side by side, and
removed without executing code.

## Phase 3: process runtime pilot

- implement the process runner and handshake;
- add operation IDs, deadlines, cancellation, health, and bounded framing;
- create one process extension with declarative contributions;
- add capability checks around one narrow host service;
- implement graceful and forced deactivation;
- verify crash, hang, malformed message, and crash-loop behavior.

Exit gate: the pilot can be installed and removed without rebuilding Shep, and
its crash does not make the base application unhealthy.

## Phase 4: UI contributions

- define versioned declarative panel, command, menu, and settings schemas;
- connect extension contributions to the existing panel registry;
- make all registrations instance-owned and disposable;
- add accessibility, theme, and unknown-contribution behavior;
- prove no UI or listener remains after disable or removal.

Exit gate: activation and deactivation are visually and operationally complete.

## Phase 5: data plane and observability

- add bounded sequenced streams and snapshot recovery;
- add backpressure and dropped-frame policies;
- correlate lifecycle, operation, process, and UI diagnostics;
- add redaction and log-volume controls;
- prove a slow consumer does not block PTY or workspace services.

Exit gate: extension stream failure is observable and contained.

## Phase 6: WASM runtime

- pin Wasmtime and WIT toolchain versions;
- define the first constrained WIT world;
- implement host imports through the same capability broker;
- add memory, fuel, timeout, filesystem, and network limits;
- port or create one provider-style extension;
- test compatibility and rollback across runtime upgrades.

Exit gate: one portable component can be independently installed and safely
deactivated on every supported desktop platform.

## Phase 7: rich isolated UI

- prototype extension content in a separate authority boundary;
- define message broker schemas and origin validation;
- enforce CSP and deny direct Tauri access;
- test lifecycle cleanup and platform-specific webview behavior;
- perform security review before enabling third-party packages.

Exit gate: rich UI cannot call undeclared host capabilities or destabilize the
main React view.

## Phase 8: distribution and catalogue

- define publisher enrollment, key rotation, and revocation;
- produce platform-specific signing and notarization pipelines;
- publish signed catalogue metadata and package digests;
- implement download, update, rollback, and offline behavior;
- verify every supported installer or sandbox format.

Exit gate: package provenance and update rollback are independently verifiable.

## Verification matrix

Every phase must cover:

- macOS arm64 and supported Intel target if retained;
- supported Windows architecture;
- supported Linux packaging formats;
- clean install, upgrade, downgrade or rollback, disable, and removal;
- host restart during each durable lifecycle transition;
- incompatible protocol and host API versions;
- unsigned, tampered, malformed, and path-traversal packages;
- crash, hang, output flood, and repeated restart;
- permission denial and revocation;
- base application behavior with zero extensions.
