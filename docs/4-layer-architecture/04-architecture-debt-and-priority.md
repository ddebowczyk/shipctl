# Architecture debt and priority

**Mode:** Tech Debt Assessment

**Scope:** Four-layer migration seams across the full Shipctl repository at
commit `ac14b3d`

**Health Score:** 70/100

The code has strong local boundaries and tests, but the module system is in a
deliberate transitional state. Six systemic warning-level risks explain why
the service wall and one lifecycle authority must come before more feature
work.

The score uses six warning findings at five points each. Pain is based on the
measured change surface and the repeated architecture and runtime corrections
that led to this plan. Spread is based on affected module count. No finding has
Pain 3 because the evidence does not prove that developers avoid the area or
that most changes fail.

## Full decay-risk scan

The scan listed all six required risk classes before scoring. Each class has
one systemic finding. This prevents a visible large file from hiding the more
important dependency and domain-boundary issues.

## Findings

### Warning

#### Change propagation: one module crosses every composition system

**Symptom:** Adding or removing a native module can affect its module manifest,
workspace packages, `package.json`, `ENABLED_MODULES`, Cargo workspace members,
`src-tauri` features and dependencies, native installation, ACL projections,
modularity profiles, and tests. The plug-out tooling exists partly to keep
these projections aligned.

**Source:** *Refactoring* — Shotgun Surgery; *A Philosophy of Software Design* —
information leakage.

**Consequence:** A module is removable only through coordinated source and
build edits. A dynamic plugin cannot become active from one admitted artifact
record.

**Remedy:** Make the admitted manifest and desired registry the runtime
authority. Generate or delete build-time projections as each native module is
absorbed into stable platform providers.

**Score:** Pain 2 × Spread 3 = 6. **Intent:** intentional transition with a
visible payback plan in this document set.

#### Dependency disorder: feature frontends hold native authority

**Symptom:** Seven module packages import `@tauri-apps/api` and call private
command names directly. Git also listens to native events. Tauri dependencies
sit in plugin package manifests.

**Source:** *Clean Architecture* — Dependency Rule; *Domain-Driven Design* —
Anti-Corruption Layer.

**Consequence:** Headless module behavior cannot run in a DOM-free harness,
presentation cannot run in a browser harness without native proxies, modules
cannot load as portable TypeScript artifacts, and code can bypass
activation-scoped service grants.

**Remedy:** Define public semantic services and keep all Tauri clients in the
trusted platform adapter. Enforce the rule in source and built artifacts.

**Score:** Pain 2 × Spread 3 = 6. **Intent:** accidental at the target boundary;
the existing design allowed it, but no current rule closes the future wall.

#### Cognitive overload: startup and module composition share one center

**Symptom:** `AppShell.tsx` has 970 lines and owns module startup, native event
lifecycle, project orchestration, terminal selection, commands, workspace, and
canvas composition. `moduleComposition.ts` adds 444 lines of contribution and
lifecycle policy, much of it defaulting to static membership.

**Source:** *A Philosophy of Software Design* — shallow modules and temporal
decomposition; *Refactoring* — Large Class.

**Consequence:** Runtime, workspace, and feature changes meet in the same
composition area. Reviewers must hold static and restart-bound lifecycles in
memory at once.

**Remedy:** Extract a host runtime facade that publishes snapshots. Let
`AppShell` consume the facade and render the selected canvas. Do not split by
hook or file kind.

**Score:** Pain 2 × Spread 3 = 6. **Intent:** accidental accumulation around a
valid original composition root.

#### Knowledge duplication: capability identity exists in several vocabularies

**Symptom:** A feature can have a package name, module ID, Cargo feature,
dependency alias, Tauri plugin name, command namespace, ACL identifier,
contribution IDs, and runtime artifact identity. TypeScript clients repeat Rust
command strings and payload shapes.

**Source:** *The Pragmatic Programmer* — DRY as single authoritative knowledge;
*Design Patterns* — duplicated protocol knowledge.

**Consequence:** An identity or protocol change can remain locally type-correct
while the Rust command, frontend client, manifest, or runtime catalog drifts.

**Remedy:** Make public semantic IDs and versioned schemas authoritative. Keep
private IPC names in one adapter and validate generated or hand-written wire
projections against shared fixtures.

**Score:** Pain 2 × Spread 3 = 6. **Intent:** accidental.

#### Accidental complexity: static and runtime module models coexist

**Symptom:** Shipctl has a mature 10,201-line module-control capability and an
immutable artifact loader, but full application modules still use the static
array. Runtime artifacts are restricted to a narrow headless activation shape
and are appended during startup. They cannot yet provide application services
or optional presentation through one dynamic activation.

**Source:** *The Mythical Man-Month* — conceptual integrity; *A Philosophy of
Software Design* — two abstractions for one responsibility.

**Consequence:** Every new module-control feature must explain whether it
affects static modules, restart-bound artifacts, or both. The newer control
plane cannot yet retire the old membership authority.

**Remedy:** Use a bounded compatibility adapter, then make one desired/applied
graph authoritative. Every bridging structure gets an explicit deletion gate.

**Score:** Pain 2 × Spread 3 = 6. **Intent:** intentional transition, now backed
by a closure sequence.

#### Domain model distortion: native placement currently implies feature ownership

**Symptom:** Assistant session workflows, TODO parsing, usage aggregation, Git
workflows, and process authority all appear as Rust module backends even though
they have different privilege and lifecycle needs.

**Source:** *Domain-Driven Design* — bounded contexts; *Clean Architecture* —
policy versus mechanism.

**Consequence:** Moving whole backend crates into core would create a stable
kernel that owns product policy. Leaving them in modules prevents
TypeScript-only plugins. Directory ownership and UI presence alone cannot
decide the split.

**Remedy:** Inventory each native operation. Move only OS authority, durable
shared resources, and enforcement into named platform providers. Keep feature
services, controllers, workflows, data processing, policy, and optional
presentation in one TypeScript plugin activation.

**Score:** Pain 2 × Spread 3 = 6. **Intent:** accidental ambiguity in the term
"module"; the target introduces "platform capability provider" to correct it.

## Debt summary

| Risk | Findings | Average priority | Classification | Intent |
| --- | ---: | ---: | --- | --- |
| Cognitive overload | 1 | 6.0 | Scheduled | accidental |
| Change propagation | 1 | 6.0 | Scheduled | intentional |
| Knowledge duplication | 1 | 6.0 | Scheduled | accidental |
| Accidental complexity | 1 | 6.0 | Scheduled | intentional |
| Dependency disorder | 1 | 6.0 | Scheduled | accidental |
| Domain model distortion | 1 | 6.0 | Scheduled | accidental |

**Recommended focus:** dependency disorder first, then lifecycle authority and
domain disposition. This order closes real authority leaks before it moves
files or expands the dynamic loader.

## Rejected claims

- Large files alone do not justify a split. `AppShell` matters because it owns
  several changing authorities, not because it exceeds a chosen line count.
- The module-control size is not itself debt. Much of it is tested domain
  infrastructure that the migration can reuse.
- Cordis does not remove the need for explicit catalogs, grants, or workspace
  ownership. Treating it as a generic solution would add accidental complexity.
- Cordis is not only a UI extension registry. Treating headless feature
  behavior as permanent host code would keep the main composition debt.
- Same-webview plugin isolation is not a security sandbox.
