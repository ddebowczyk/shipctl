# Decisions, risks, and review

<!-- markdownlint-disable MD013 -->

## Purpose

This document separates fixed architecture decisions from implementation
choices and later product choices. Reviewers can amend one item without
reopening the whole direction.

## Decisions proposed for approval

1. The permanent platform has a Rust native kernel and a trusted TypeScript
   application host. The application host initially executes in the main
   webview. “Core” is not Rust-only.
2. `core/backend` stays Tauri-free. `core/tauri` and `src-tauri` keep Tauri
   private from public plugin contracts.
3. `core/frontend/platform` is the only frontend Tauri import boundary.
4. `module-api/` is the public TypeScript plugin contract and has no host
   implementation or renderer-specific type.
5. Feature modules end as TypeScript-only Cordis application plugins. They can
   be headless, presentation-only, or compound. Native mechanism moves to named
   platform capabilities; feature services and policy do not.
6. Cordis owns TypeScript application composition, service dependency
   injection, activation, and effect lifetime through a Shipctl-owned adapter.
   Shipctl owns admission, grants, native resource authority, workspace, and
   reconciliation.
7. Built-ins and installed plugins use one immutable artifact and runtime path.
8. Contributions are activation-owned registrations published as one accepted
   catalog snapshot.
9. The semantic workspace is durable product state. Legacy and Layman canvases
   are replaceable projections.
10. Reviewed same-realm plugins are the first trust tier. Capability grants
    constrain supported operations but do not claim to sandbox hostile
    JavaScript.
11. A headless service fixture proves the no-React path. `commands` is the first
    compound Cordis/artifact pilot. `ports` is the first native provider
    extraction pilot.
12. Each slice starts from semantics and property cards and ends with proof and
    deletion of its old authority path.
13. Plugin Data initially uses one instance-scoped, versioned
    `plugin-data.json` document. An exact catalog admits records. No byte quota
    is selected without an owned product value or measured evidence. Legacy
    YAML is read-only until first write, so downgrade keeps the old value but
    cannot observe post-cutover edits.

## Clarifications that close earlier ambiguity

- A macOS `.app` bundle can contain the UI executable and resources while the
  installer also places a separate CLI executable on `PATH`. Package shape does
  not require one universal binary.
- A TypeScript-only plugin can use native capability through a typed host
  service. It does not need a Rust companion crate.
- A TypeScript-only plugin can also provide application services, execute
  workflows, process data, and own background effects without a React surface.
- A module manifest declares required and provided services, background
  responsibilities, optional contributions, and native needs. It does not grant
  its own authority or install native code.
- Cordis is the TypeScript application-composition and lifecycle backbone, not
  the security boundary or OS container.
- Layman is a renderer adapter, not the workspace document or plugin contract.
- Moving Rust files from `modules/` to `core/` is valid only after the moved
  behavior is classified as platform mechanism.
- The existing module-control registry and immutable artifact work are assets.
  The plan extends them from restart-bound artifact metadata to the one live
  TypeScript application lifecycle; it does not replace them with a second
  registry.

## Implementation choices that remain open

| Choice | Decision point | Required evidence or owner |
| --- | --- | --- |
| Exact service names and method shapes | Each Phase B capability record | Call-site inventory, fake-host ergonomics, and native authority model |
| Cordis revision at implementation start | Phase C task claim | Verify current upstream source, then pin an exact revision and adapter tests |
| Artifact module format and external allowlist | Phase E record review | Vite/browser loader experiment, reproducible build, and closure property |
| Host supply mechanism for React, React DOM, Cordis, and plugin API singletons | Phase E loader record | Browser import-map or loader experiment plus runtime identity property |
| Final manifest compatibility negotiation | Phase E schema review | Version-range semantics, forward and backward fixtures, and admission policy |
| Workspace missing-view policy by contribution kind | Phase G workspace record | Product review and generated reconciliation histories |
| Live artifact discovery trigger | Phase F record | Control-plane and filesystem event behavior; no polling value is invented here |
| Legacy canvas retirement | Phase H cutover | Dariusz Debowczyk authorized retirement on 2026-08-19 after the named semantic-workspace, admitted-contribution, and terminal parity evidence |
| Dedicated TypeScript realm for headless work | Phase H delivery | The packaged Node sidecar preserves a narrow ABI and failure envelope; a compiled runner may replace it later only by preserving that contract and proving package parity |
| Strong isolation for untrusted plugins | A later security program | Threat model and process or realm design |

These choices do not block approval of the authority model. Their records must
be approved before the relevant implementation slice starts.

## Primary risks and controls

### Cordis upstream is pre-release

The inspected upstream identifies itself as `4.0.0-rc.8`. Its API can change.
Pin an exact source revision, expose only a small Shipctl adapter, and run
lifecycle conformance against an upgrade candidate before changing the pin.
The DeepSeek harness is useful design evidence, but its private fork is not a
Shipctl dependency.

### Same-realm code can bypass cooperative rules

An activation grant is not a JavaScript sandbox. Initial artifacts are reviewed
and admitted as trusted code. Static import closure, runtime admission, service
authorization, and clear documentation prevent an accidental claim of hostile
isolation. A stronger trust tier needs a separate realm or process.

### Dynamic module caching can hide replacement defects

Artifact identity includes a digest. The loader must use digest-addressed URLs
or an equivalent cache-safe mechanism and prove that same-ID replacement loads
the accepted bytes. Runtime snapshots report both plugin ID and artifact
digest.

### Partial activation can leak effects

Candidates activate outside the live runtime snapshot. Every Cordis service
provider, effect, contribution, subscription, timer, worker, connection, and
resource lease receives an activation owner. Failed readiness disposes the
complete candidate graph before the old snapshot changes.

### Native extraction can move feature policy into core

Each disposition record classifies operations as platform mechanism, feature
policy, or transitional coupling. Review and property claims use that
classification. A Rust deletion does not justify a feature-shaped core API.

### Durable migrations can lose user state

Usage, assistant sessions, layouts, and plugin data need explicit schema
authority, backup, read-old/write-new behavior, recovery, and downgrade
decisions. The migration uses isolated fixtures and packaged restart proofs
before it touches the authoritative format.

### Resource disposal can destroy live work

Host resources and activation leases are distinct. Disposing a plugin removes
its lease and UI effects. It does not kill a terminal, watcher, or session
unless the resource contract assigns activation ownership or an explicit user
operation requests destruction.

### Dual authority can become permanent

Every compatibility adapter and cutover switch names an old path and deletion
gate. Architecture snapshots reject a completed disposition with residual old
edges. There is one selected writer and one accepted catalog revision.

### Renderer state can become domain state

Only semantic workspace documents persist. Canvas adapters normalize external
renderer state and send semantic commands. Differential projection and
roundtrip properties detect Layman-specific state leakage.

### Generated checks can give false confidence

Property oracles remain independent. Mutation fixtures prove that source and
artifact checks reject each forbidden edge. Run evidence reports generated
class coverage and preserved counterexamples, not only a green status.

### Migration scope can become a rewrite

Each slice keeps the existing UI and public behavior unless a reviewed semantic
rule changes it. The strangler sequence adds a service boundary, switches one
consumer or provider, proves it, and deletes the replaced path. Directory
beauty, visual redesign, and unrelated cleanup do not enter the critical path.

## Alternatives rejected for this program

- **Rust-only core:** rejected because the TypeScript application host must own
  Cordis services and lifecycle, optional React, workspace, and platform
  adapters.
- **Cordis as a UI-only extension registry:** rejected because feature services,
  workflows, background work, and presentation need one composable activation
  and disposal model.
- **Direct Tauri access from plugins:** rejected because it makes grants,
  fakes, portability, and dynamic loading nominal rather than enforceable.
- **One Rust crate per optional feature:** rejected because installable
  TypeScript plugins cannot add or remove linked native code at runtime.
- **Cordis as the permission or native-resource system:** rejected because its
  lifecycle scope does not establish OS authority or hostile-code isolation.
- **Layman types in plugin contracts:** rejected because it couples feature
  packages and durable layouts to one renderer.
- **A second plugin registry for the frontend:** rejected because the current
  module-control registry should remain the durable desired-state authority.
- **Move directories first:** rejected because a move preserves hidden
  dependency direction and can turn feature policy into permanent core.
- **A broad Node sidecar as an escape hatch:** rejected because it creates a
  second privileged platform without proving that a specific capability needs
  it.

## Human review checklist

Approve, amend, or reject:

- [ ] the four layers and their one-way authority;
- [ ] the semantic service wall as the first runtime change;
- [ ] the split between TypeScript application-lifecycle work and
      native-provider work;
- [ ] headless, presentation-only, and compound plugins under one application
      activation model;
- [ ] the main webview as initial execution placement, without making UI a
      plugin responsibility requirement;
- [ ] Cordis pinning and the Shipctl-owned adapter;
- [ ] same-realm reviewed plugins as the stated initial trust tier;
- [ ] one immutable path for built-in and installed plugins;
- [ ] the semantic workspace and renderer boundary;
- [ ] the module disposition matrix, especially TODO, usage, assistants, and
      semantic terminal policy boundaries;
- [ ] property specifications, independent oracles, mutation proof, and
      deletion gates as task completion requirements;
- [ ] the execution graph and the two pilots;
- [ ] the listed deferred decisions and their decision points.

## Approval result

Reviewers approved the plan. Document 16 is compiled into dependency-linked
Beads child tasks under `shep-vut`. Phase A added executable contracts, passive
entrypoint enforcement, a characterized baseline, and replay support without
changing runtime behavior. Phase B is the next implementation boundary.

If reviewers amend a boundary, update the relevant normative semantics,
property cards, disposition records, and graph edge before task creation. Do
not patch the task list while the architecture source remains inconsistent.
