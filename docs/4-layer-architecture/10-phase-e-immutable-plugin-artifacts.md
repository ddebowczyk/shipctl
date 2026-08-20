# Phase E: immutable plugin artifacts

## Outcome

Build and load a built-in application plugin through the same immutable
artifact format intended for installed plugins. The format supports headless,
presentation-only, and compound plugins. Extend the current loader without yet
reacting to live registry changes.

`commands` is the first artifact because it has no Rust backend and already
uses host terminal services. This isolates artifact packaging from native
provider extraction.

Phase E has two delivery steps. The first establishes the artifact format,
builder, admission checks, loader, and a complete headless lifecycle. The
second packages and cuts over each built-in. The foundation and the Commands,
Ports, Todos, Git, Skills, Thin Terminal, Semantic Terminal, and Assistants
slices are
implemented and proved. The remaining module migrations reuse this path; live
replacement is owned by Phase F.

## Normative semantics

- **SEM-E-001:** Runtime installation consumes compiled immutable artifacts and
  never runs TypeScript compilation or package-manager scripts.
- **SEM-E-002:** Artifact identity includes a content digest and every import
  URL is qualified by that digest.
- **SEM-E-003:** The admitted manifest and runtime registrations agree on
  identity, required and provided services, grants, messages, background
  responsibilities, and optional declarative contributions.
- **SEM-E-004:** React, React DOM, Cordis, and the plugin API are host-supplied
  singleton identities and are not bundled into plugin artifacts.
- **SEM-E-005:** Importing an artifact is passive; activation and publication
  require explicit supervisor actions.
- **SEM-E-006:** An invalid, incompatible, or tampered artifact becomes an
  inspectable failure and cannot affect active catalogs.
- **SEM-E-007:** A built-in artifact and an installed artifact use the same
  loader and runtime contract.
- **SEM-E-008:** Admission accepts an artifact only when its plugin API range,
  manifest schema, required service versions, and contribution schema versions
  are compatible with the host. Unknown required semantics fail closed.
- **SEM-E-009:** The application entry point is required, but React, CSS,
  assets, and presentation contributions are optional. A valid artifact can
  provide only services and headless effects.

## Artifact shape

```text
<plugin-id>/<content-digest>/
  module.yaml       required closed manifest
  dist/
    plugin.mjs      required application entry point
    chunks/         optional bundled private dependencies
    assets/         optional generated CSS and assets
  messages/         optional contract schemas
  capabilities/     optional capability definitions
  assets/           optional
  integrity.json    generated only by the trusted packer
```

The source plugin supplies `module.template.json` and `src/index.ts`. The Vite
artifact builder emits a closed staging tree and generates `module.yaml`. The
trusted Rust packer generates `integrity.json`, creates a deterministic TAR
archive, validates it with the production reader, and refuses to overwrite an
existing output. Runtime installation never runs Vite, TypeScript, or package
manager scripts.

The native repository validates and publishes files under the content digest.
The TypeScript application runtime receives only an admitted descriptor and
digest-qualified entry path. Stable non-digest URLs are not valid replacement
identities.

The manifest declares required and provided service identities, application
entry point, readiness, effects, and optional presentation contributions. It
does not classify the artifact by UI presence.

Contribution identity follows the public contract of its family. Most
contribution families use a dotted scoped ID. A `terminal-presentation` uses
the existing `TerminalDriverId` grammar because its ID selects the same driver
across launch, attachment, and presentation. Admission applies this rule in
both the native manifest reader and the TypeScript declaration comparison.

The application entry exports `createShipctlPlugin(host)`. Importing the entry
does not call this factory and does not activate the plugin. The host calls the
factory once, supplies exact React, React DOM, and plugin API singleton
identities, and compares the resulting declarations with the admitted
manifest. Cordis stays private to the host runtime. Plugin code uses Shipctl
activation and service contracts; it does not import or receive a Cordis
context.

The repository build command is:

```sh
node ops/architecture/bin/build-plugin-artifact.mjs \
  --source <plugin-source> \
  --to <artifact.shipctl-module>
```

The builder delegates archive creation to `shipctl modules pack`. Both commands
produce structured evidence. `shipctl modules preflight --offline` and
`shipctl modules add --offline` use the same production archive reader and
compatibility policy as startup admission.

## Work

1. Extend the existing Rust `RuntimeArtifactManifest` rather than define a
   second manifest.
2. Add public plugin API compatibility, required and provided service
   declarations, and optional contribution declarations.
3. Add a Vite artifact build mode with shared-package externalization.
4. Seed the application loader with exact Cordis and plugin API identities and
   optional React identities.
5. Replace the current contribution allowlist with typed candidate service,
   effect, and contribution collection.
6. Package the headless provider/consumer fixture as a no-React artifact and
   prove its complete lifecycle.
7. Package commands as a built-in compound artifact and admit it during app
   build or first-run initialization.
8. Load it at startup through the existing digest-qualified path and activate
   it through Cordis.
9. Compare its headless behavior, catalog, and UI behavior with the statically
   linked command module.
10. Switch commands to artifact authority and remove its static package import.
11. Repeat for a second low-risk plugin before generalizing the build tool.

## Property cards

### PROP-E-ARTIFACT-001

- **Claim:** Packing, admitting, reading, and canonicalizing every generated
  valid plugin tree preserves its manifest meaning and exact file bytes.
- **Shape:** roundtrip.
- **Evidence:** SEM-E-001, SEM-E-002.
- **Domain:** generated normalized paths, JavaScript, CSS, assets, schemas,
  Unicode metadata, empty optional directories, and file order. Exclude files
  above limits defined by the artifact contract, once those limits have an
  authoritative source.
- **Preconditions:** generated manifests satisfy the versioned schema.
- **Oracle:** retain original normalized path/byte tuples and compare them with
  the admitted directory plus canonical manifest.
- **Failure value:** packaging changes asset bytes or loses a schema while the
  digest still appears valid.
- **Tier:** pull request.
- **Initial status/test ID:** proposed / `architecture.artifact-roundtrip.property`.

### PROP-E-TAMPER-001

- **Claim:** Any generated mutation of a covered artifact byte, normalized
  path, integrity entry, identity, or digest causes admission or load to fail
  before activation.
- **Shape:** safety.
- **Evidence:** SEM-E-002, SEM-E-006.
- **Domain:** single and multiple mutations, path traversal, symlinks, missing
  files, extra files, digest mismatch, and manifest mismatch. Exclude storage
  corruption after a separate successful native read; runtime integrity policy
  must state whether and when that is rechecked.
- **Preconditions:** start from a valid generated artifact.
- **Oracle:** compare pre-mutation retained bytes and independently recomputed
  SHA-256 values.
- **Failure value:** a modified `dist/plugin.mjs` runs under the digest of admitted
  code.
- **Tier:** pull request.
- **Initial status/test ID:** proposed / `architecture.artifact-tamper.property`.

### PROP-E-EXTERNALS-001

- **Claim:** Every built plugin artifact resolves each shared runtime package
  to the host seed and contains no bundled second copy of that package.
- **Shape:** safety.
- **Evidence:** SEM-E-004.
- **Domain:** generated plugin dependency graphs and imports of React, React
  DOM, Cordis, plugin API, and allowed bundled dependencies. Exclude minifier
  implementation details that do not change module identity.
- **Preconditions:** build succeeds.
- **Oracle:** inspect the build metafile and runtime identity probes from the
  host, independent of plugin source declarations.
- **Failure value:** a plugin bundles another React instance and hooks fail at
  runtime.
- **Tier:** pull request and release packaging.
- **Initial status/test ID:** proposed / `architecture.artifact-externals.property`.

### PROP-E-MANIFEST-RUNTIME-001

- **Claim:** Every candidate artifact activates only when its complete runtime
  registration set equals the admitted manifest declarations after canonical
  normalization.
- **Shape:** differential.
- **Evidence:** SEM-E-003, SEM-E-006.
- **Domain:** generated manifests and plugin factories with missing, extra,
  reordered, duplicate, or altered services, grants, messages, and
  contributions.
- **Preconditions:** artifact bytes and API version are valid.
- **Oracle:** compare two independently collected sets: native-admitted
  declarations and provisional runtime registrations.
- **Failure value:** a plugin declares no menu item but registers one after
  admission.
- **Tier:** pull request.
- **Initial status/test ID:** proposed / `architecture.manifest-runtime.property`.

### PROP-E-BUILTIN-PARITY-001

- **Claim:** For every generated commands-plugin state and action sequence, the
  built-in artifact path and static reference path produce equivalent public
  commands, panels, terminal launches, and notices.
- **Shape:** differential.
- **Evidence:** SEM-E-007.
- **Domain:** generated saved commands, project paths, launch results, and
  service failures. Exclude pixel rendering.
- **Preconditions:** both paths use equivalent in-memory services.
- **Oracle:** compare normalized contribution catalogs and fake-service action
  logs from isolated hosts.
- **Failure value:** the artifact loads but its command launches a terminal
  with different metadata.
- **Tier:** pull request.
- **Current status/test ID:** passing / `architecture.commands-artifact-parity.property`.

### PROP-E-PORTS-PARITY-001

- **Claim:** For every generated Ports process state and failure mode, the
  built-in artifact path and static reference path produce equivalent
  navigation, scans, filtering, termination results, and service traces.
- **Shape:** differential.
- **Evidence:** SEM-E-007.
- **Domain:** generated listener facts, project paths, development and filtered
  process names, framework commands, and inspection or termination denials.
  Exclude pixel rendering and real process termination.
- **Preconditions:** both paths use equivalent isolated process services.
- **Oracle:** compare normalized catalogs, public results, and semantic service
  traces from isolated hosts; then require empty runtime ledgers after repeated
  disposal.
- **Failure value:** the artifact filters a listener or terminates an
  inspection differently from the source module.
- **Tier:** pull request.
- **Current status/test ID:** passing / `architecture.ports-artifact-parity.property`.

### PROP-E-TODOS-PARITY-001

- **Claim:** For every generated Todos project catalog, persisted preference,
  and document failure mode, the built-in artifact path and direct source
  definition produce equivalent contributions, project lifecycle requests,
  service traces, and disposal.
- **Shape:** differential.
- **Evidence:** SEM-E-007.
- **Domain:** generated enabled and disabled preferences, project catalog and
  filesystem changes, discovered TODO documents, and permitted or denied
  discovery. Exclude pixel rendering and native filesystem access.
- **Preconditions:** both paths use equivalent isolated project-document,
  project-catalog, and plugin-data services.
- **Oracle:** compare normalized catalogs and attributed service traces from
  isolated hosts; then require passive style loading, one executable file, and
  empty runtime ledgers after repeated disposal.
- **Failure value:** the artifact discovers TODO documents, reacts to a project
  lifecycle change, or publishes contributions differently from its direct
  source definition.
- **Tier:** pull request.
- **Current status/test ID:** passing / `architecture.todos-artifact-parity.property`.

### PROP-E-GIT-PARITY-001

- **Claim:** For every generated Git repository state, refresh result, and
  stored worktree preference, the built-in artifact path and direct source
  definition path produce equivalent contributions, project facts, related
  paths, service traces, and disposal.
- **Shape:** differential.
- **Evidence:** SEM-E-007.
- **Domain:** generated repository identities, branch names, clean and dirty
  status, worktrees, stored preferences, expansion settings, project-catalog
  changes, repository-change events, and permitted or denied status reads.
  Exclude pixel rendering and native Git execution.
- **Preconditions:** both paths use equivalent isolated Git, project-catalog,
  and plugin-data services.
- **Oracle:** compare normalized catalogs, project facts, related paths, and
  attributed service traces; then require passive style loading, one executable
  file, and empty runtime ledgers after repeated disposal.
- **Failure value:** the artifact refreshes repository state or expands related
  worktrees differently from the direct source definition.
- **Tier:** pull request.
- **Current status/test ID:** passing / `architecture.git-artifact-parity.property`.

### PROP-E-SKILLS-PARITY-001

- **Claim:** For every generated Skills project catalog, workflow action, and
  service failure, the built-in artifact and direct source definition produce
  equivalent contributions, catalog projections, service traces, notices, and
  disposal.
- **Shape:** differential.
- **Evidence:** SEM-E-007 and SEM-E-009.
- **Domain:** generated project identities, installed skill states, lifecycle
  refreshes, provider and project-action calls, and permitted or denied
  inspection, installation, and removal. Exclude native filesystem access.
- **Preconditions:** both paths use equivalent isolated Skill Installation and
  project-catalog services.
- **Oracle:** compare normalized catalogs, snapshots, project actions, notices,
  and attributed service traces; then require no React or presentation files,
  one executable file, project-cache eviction, and empty runtime ledgers after
  repeated disposal.
- **Failure value:** the artifact installs a different Markdown source, changes
  a user-visible failure, or retains a removed project's cache.
- **Tier:** pull request.
- **Current status/test ID:** passing / `architecture.skills-artifact-parity.property`.

### PROP-E-THIN-TERMINAL-PARITY-001

- **Claim:** For generated terminal identities and visibility states, the
  admitted artifact and source direct artifact definition register equal terminal presentation,
  authority, service, and React wrapper contracts.
- **Shape:** differential lifecycle.
- **Evidence:** SEM-E-007 and SEM-E-009.
- **Domain:** terminal identities, visible and hidden states, focus scheduling,
  key and paste bytes, resize dimensions, raw output, exit, and teardown.
  Exclude pixel rendering and native PTY execution.
- **Preconditions:** both paths use the host React singleton and the public
  Terminal Sessions service.
- **Oracle:** compare normalized catalogs and wrapper props, then require one
  digest-qualified stylesheet, passive import, and empty ledgers and styles
  after repeated disposal. Compose the focused terminal helper and service-fake
  properties for interaction behavior.
- **Failure value:** the artifact changes terminal authority, loses its
  presentation, or retains xterm styles after disposal.
- **Tier:** pull request and packaged-product proof.
- **Current status/test ID:** passing /
  `architecture.thin-terminal-artifact-parity.property`.

### PROP-E-SEMANTIC-TERMINAL-PARITY-001

- **Claim:** For generated terminal identities and visibility states, the
  admitted artifact and source direct artifact definition publish equal semantic-terminal
  presentation, authority, service, and React wrapper contracts.
- **Shape:** differential lifecycle.
- **Evidence:** SEM-E-007 and SEM-E-009.
- **Domain:** terminal identities, visible and hidden states, attachment and
  flow-control state, input, resize, screen revisions, history, anchors,
  selection, paste decisions, and teardown. Exclude pixel rendering and native
  PTY execution.
- **Preconditions:** both paths use the host React singleton and the public
  Terminal Sessions and Semantic Terminals services.
- **Oracle:** compare normalized catalogs and wrapper props, then require one
  digest-qualified stylesheet, passive import, and empty ledgers and styles
  after repeated disposal. Compose the existing Semantic Terminal interaction
  suite and both service fakes for behavioral coverage.
- **Failure value:** the artifact changes semantic authority, loses its
  presentation, or retains styles after disposal.
- **Tier:** pull request and packaged-product proof.
- **Current status/test ID:** passing /
  `architecture.semantic-terminal-artifact-parity.property`.

### PROP-E-ASSISTANTS-PARITY-001

- **Claim:** For generated provider availability, model catalogs, and
  credential states, the admitted artifact and source direct definition publish equal
  launcher, authority, semantic-service, restore, shutdown, and disposal
  behavior.
- **Shape:** differential lifecycle.
- **Evidence:** SEM-E-007 and SEM-E-009.
- **Domain:** provider identities, command availability, model catalogs,
  credential status, session inspection, restore warning, shutdown, and
  teardown. Exclude pixel rendering and native process or credential access.
- **Preconditions:** both paths use isolated Assistant Launch, Credential Store,
  Processes, Terminal Sessions, and Projects fakes and equivalent host lifecycle
  ports.
- **Oracle:** compare normalized catalogs, service results and traces, restore
  notices, panel exports, runtime ledgers, and host subscription traces. Also
  require one executable, no loose assets or styles, exact grants and service
  declarations, and empty ledgers after repeated disposal.
- **Failure value:** the artifact changes assistant authority, loses the
  launcher panel, bypasses a semantic service, or retains a terminal
  subscription.
- **Tier:** pull request and packaged-product proof.
- **Current status/test ID:** passing /
  `architecture.assistants-artifact-parity.property`.

### PROP-E-USAGE-PARITY-001

- **Claim:** For generated provider and settings inputs, the admitted Usage
  artifact and source direct definition publish equal catalogs, source ingestion,
  observation, directed refresh, schedule registration, presentation loading,
  activation inspection, and disposal behavior.
- **Shape:** differential lifecycle.
- **Evidence:** SEM-E-007 and SEM-E-009.
- **Domain:** provider identities, visibility, budget mode, monthly budget,
  preserved settings extensions, source refresh, source-change delivery,
  scheduled message routing, denied source observation, presentation imports,
  and teardown. Exclude pixel rendering and native provider subprocess or
  credential access.
- **Preconditions:** both paths use isolated Usage Sources, Plugin Data,
  Messages, and Scheduler fakes with the same activation identity.
- **Oracle:** compare normalized catalogs, service traces, message receipts,
  presentation exports, and runtime ledgers. Also require one executable, one
  stylesheet, no loose assets, exact grants and service declarations, atomic
  withdrawal after a denied observer grant, and empty ledgers after repeated
  disposal. The Usage characterization suite separately preserves pricing,
  alias review, aggregation, and presentation policy.
- **Failure value:** the artifact changes ingestion or refresh behavior, loses
  a Usage surface, bypasses semantic services, or retains an observer or
  schedule.
- **Tier:** pull request and packaged-product proof.
- **Current status/test ID:** passing /
  `architecture.usage-artifact-parity.property`.

### PROP-E-COMPATIBILITY-001

- **Claim:** For every generated host and artifact version tuple, admission
  accepts exactly the tuples allowed by the independent compatibility model.
- **Shape:** differential.
- **Evidence:** SEM-E-006, SEM-E-008.
- **Domain:** plugin API ranges at and around boundaries, pre-release versions,
  supported and unsupported manifest schemas, required and optional service
  versions, contribution schema versions, missing requirements, and malformed
  ranges.
- **Preconditions:** version strings are either valid values or explicit
  malformed cases from the input generator.
- **Oracle:** a small compatibility table evaluates each dimension separately
  and combines required dimensions with fail-closed conjunction. It does not
  call the production manifest parser or range evaluator.
- **Failure value:** a plugin built against a newer required terminal-stream
  contract activates on an older host and corrupts its replay state.
- **Tier:** pull request and release packaging.
- **Initial status/test ID:** proposed /
  `architecture.artifact-compatibility.property`.

### PROP-E-HEADLESS-001

- **Claim:** For every generated valid headless artifact, pack, admission,
  import, activation, service use, inspection, and disposal succeed without a
  React dependency or presentation declaration.
- **Shape:** roundtrip lifecycle.
- **Evidence:** SEM-E-001, SEM-E-003, SEM-E-005, SEM-E-009.
- **Domain:** service providers and consumers, background effects, commands,
  configuration, and zero presentation files. Exclude native process crash.
- **Preconditions:** service versions and native grants are compatible.
- **Oracle:** compare the retained manifest and effect ledger with the admitted
  descriptor, runtime inspection snapshot, and post-disposal ledger.
- **Failure value:** artifact admission or activation assumes that every plugin
  has a React component or CSS file.
- **Tier:** pull request and packaged-product proof.
- **Initial status/test ID:** proposed / `architecture.headless-artifact.property`.

## Exit proof

The artifact-foundation step proves:

- repeated source builds and native packs are byte-identical;
- covered byte, manifest, path, file-set, and integrity mutations fail before
  activation;
- schema-v2 application declarations match runtime registrations exactly;
- the Vite output contains no bundled or unresolved shared runtime dependency;
- a no-React fixture completes build, pack, preflight, admission, passive
  import, activation, service use, inspection, and idempotent disposal;
- generated plugin API, manifest, service, and contribution version tuples
  match an independent native compatibility model.

Replay these proofs with:

```sh
just --justfile ops/architecture/justfile plugin-artifacts --seed=1717
```

The commands cut-over proves:

- commands has no static import in `ENABLED_MODULES`;
- commands is loaded from a digest-qualified admitted artifact;
- agent inspection reports built-in provenance, digest, activation, grants,
  services, and contributions;
- generated saved-command, project-path, launch-result, and failure traces are
  equal between the static reference and artifact paths;
- repeated disposal leaves no services, contributions, effects, or styles;
- a packaged Tauri application contains the embedded artifact and no static
  Commands presentation chunk;
- restart remains allowed at this phase; live changes are Phase F.

The Ports, Todos, Git, Skills, Thin Terminal, Semantic Terminal, and Assistants
cut-overs reuse the same path and prove:

- Ports has no static import in `ENABLED_MODULES` or root package dependency;
- the admitted artifact declares `shipctl.processes@1` and presentation-only
  navigation and surface contributions;
- generated successful scans, filtering, inspection denials, termination
  denials, and process-service traces equal the source-module reference;
- repeated disposal leaves no service, contribution, or effect ledger entry;
- generated bundle inventory seeds Commands, Ports, Todos, Git, Skills, Thin
  Terminal, Semantic Terminal, and Assistants as enabled immutable frontend
  artifacts;
- each artifact declares only its required semantic platform services and exact
  contribution catalog;
- Git refresh, fact projection, worktree expansion, catalog lifecycle, and
  semantic repository-change handling match the direct source definition for
  generated clean, dirty, allowed, and denied cases.
- Skills directly declares `shipctl.skill-installation@2` and
  `shipctl.projects@1`, has no React or presentation files, and owns the
  generic project-catalog lifecycle through its `skills.runtime` effect. It
  matches source behavior for generated discovery, refresh, installation,
  removal, denial, notice, cache eviction, and disposal cases.
- Thin Terminal declares `shipctl.terminal-sessions@1` and exact grants, bundles
  xterm, carries one admitted stylesheet, and removes that stylesheet with its
  activation while its host-owned session remains independent.
- Semantic Terminal declares `shipctl.terminal-sessions@1` and
  `shipctl.semantic-terminals@1`, its exact six grants, one presentation, and
  one activation-owned stylesheet. Its existing interaction suite preserves
  attach, flow control, history, selection, paste, input, resize, and teardown.
- Assistants declares `shipctl.assistant-launch@1`,
  `shipctl.credential-store@1`, `shipctl.processes@1`,
  `shipctl.terminal-sessions@1`, and `shipctl.projects@1`; its
  `assistants.runtime` activation effect owns project and terminal subscriptions.
  It requests its exact six grants and publishes one compound launcher panel.
  Differential properties preserve restore, shutdown, service access, panel
  loading, activation subscription, and teardown behavior.

## Deletion gate

The gate is satisfied for Commands, Ports, Todos, Git, Skills, Thin Terminal,
Semantic Terminal, and Assistants. The candidate collector rejects undeclared
services, UI contributions, and non-UI effects. Their static imports and root package
dependencies were deleted after artifact parity and bundle inventory proofs
passed.
