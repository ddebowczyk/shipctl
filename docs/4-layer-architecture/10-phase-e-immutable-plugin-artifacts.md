# Phase E: immutable plugin artifacts

## Outcome

Build and load a built-in application plugin through the same immutable
artifact format intended for installed plugins. The format supports headless,
presentation-only, and compound plugins. Extend the current loader without yet
reacting to live registry changes.

`commands` is the first artifact because it has no Rust backend and already
uses host terminal services. This isolates artifact packaging from native
provider extraction.

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
  plugin.json
  plugin.js        required application entry point
  plugin.css        optional
  assets/           optional
  schemas/          optional
  integrity.json
```

The build emits the artifact into staging. The native repository validates and
publishes it under its digest. The TypeScript application runtime receives only
an admitted descriptor and entry path. Stable non-digest URLs are not valid
replacement identities.

The manifest declares required and provided service identities, application
entry point, readiness, effects, and optional presentation contributions. It
does not classify the artifact by UI presence.

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
- **Failure value:** a modified `plugin.js` runs under the digest of admitted
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
- **Initial status/test ID:** proposed / `architecture.commands-artifact-parity.property`.

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

- commands has no static import in `ENABLED_MODULES`;
- commands is loaded from a digest-qualified admitted artifact;
- a headless fixture artifact provides a service and owns a background effect
  without React or presentation declarations;
- its contributions are accepted only after provisional validation;
- invalid fixture artifacts cannot change active state;
- incompatible API, service, manifest, and contribution versions fail before
  activation with structured diagnostics;
- build output contains no private shared runtime copies;
- agent inspection reports built-in provenance, digest, activation, grants,
  services, and contributions;
- restart remains allowed at this phase; live changes are Phase F.

## Deletion gate

Delete the legacy contribution allowlist when the new candidate collector
rejects all undeclared services, UI contributions, and non-UI effects. Delete
the commands static import and root package dependency only after artifact
parity and packaged-app tests pass.
