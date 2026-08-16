# Property oracle review

<!-- markdownlint-disable MD013 -->

## Purpose

The local property-testing method requires two independent oracle candidates
and a statement of how each can be wrong. Documents 06 through 12 define the
claims, generators, first oracle candidates, and expected failures. This
document adds the independent alternative and makes the oracle selection a
reviewed decision.

An alternative is not automatically better. Some properties need both
oracles: a pure model defines meaning, while a differential or integration
probe checks that the model reaches the real boundary.

## Phase A: specification and baseline

| Property | First-oracle failure mode | Alternative oracle | Alternative failure mode |
| --- | --- | --- | --- |
| `PROP-A-SPEC-001` | The pure graph model can repeat a mistaken reading of the record semantics. | Apply one controlled valid or invalid mutation to a known record corpus and compare the expected diagnostic code. | The mutation corpus can omit interactions between several defects. |
| `PROP-A-IMPORT-001` | Runtime tripwires can miss an uninstrumented side-effect channel. | Resolve the package and built-artifact import graphs and reject executable top-level registrations or forbidden dependencies. | Static analysis can miss computed imports and indirect runtime side effects. |
| `PROP-A-COMPOSITION-001` | Normalization can hide a contribution field that matters to consumers. | Query independently built current registries and compare their public projections with the candidate catalog. | The registry query can share current implementation defects and bless them. |
| `PROP-A-REPLAY-001` | A stored normalized value can omit an environment fact needed for replay. | Replay in a fresh process and compare property ID, runner identity, exit class, and minimized artifact hash. | Process isolation cannot reproduce an external OS or timing condition that the artifact failed to record. |

## Phase B: semantic service wall

| Property | First-oracle failure mode | Alternative oracle | Alternative failure mode |
| --- | --- | --- | --- |
| `PROP-B-BOUNDARY-001` | The independent graph classifier can model TypeScript resolution incorrectly. | Inspect the package-manager graph and bundler metafile for forbidden resolved package owners. | Tree shaking can hide a forbidden source edge that is absent from one build. |
| `PROP-B-ADAPTER-001` | The legacy client can contain the same semantic defect and make equality misleading. | Apply the capability's pure request/result/error model to the adapter trace. | The model can omit undocumented compatibility behavior needed by the UI. |
| `PROP-B-FAKE-001` | Generated workflows can omit an indirect native access path. | Run the plugin entry and workflow in a browser harness with no Tauri global or package resolution. | The browser harness can differ from the packaged webview in setup or globals. |
| `PROP-B-ACTIVATION-001` | The capture harness can attach its expected identity at the wrong call site. | Check the request identity again at the private IPC boundary against the admitted activation ledger. | A compromised trusted adapter could forge both values before native enforcement exists. |
| `PROP-B-REQUEST-001` | The pure model can state the wrong cancellation or retry policy. | Compare an isolated legacy transport trace for preserved operations and semantic golden cases for changed rules. | The legacy path can contain the defect, and golden cases cover fewer histories. |
| `PROP-B-EVENT-001` | The retained-log filter can model scope or source ordering incorrectly. | Use source-side sequence canaries and assert per-lease delivery and disposal at the consumer boundary. | Canaries can miss real payload or concurrency classes. |
| `PROP-B-STREAM-001` | The deque model can omit a transport-level backpressure rule. | Drive a real PTY canary through the packaged stream and compare sent, acknowledged, retained, and rendered sequence hashes. | The canary covers one OS and terminal behavior and is slower to shrink. |

## Phase C: Cordis static composition

| Property | First-oracle failure mode | Alternative oracle | Alternative failure mode |
| --- | --- | --- | --- |
| `PROP-C-LIFECYCLE-001` | The pure lifecycle model can omit a valid Cordis transition. | Compare the normalized Cordis activation and disposal event trace with reviewed transition tables. | Instrumentation can depend on unstable Cordis internals. |
| `PROP-C-EFFECTS-001` | The command model can fail to list a newly introduced effect family. | Install unique canaries for timers, subscriptions, contributions, and leases, then inspect all canaries after quiescence. | The canary set can also omit an effect family and cannot prove unreachable memory was collected. |
| `PROP-C-STATIC-PARITY-001` | Both builders can share a compatibility adapter and the same omission. | Compare the candidate catalog with a reviewed golden inventory emitted by the current packaged app. | The golden inventory can become stale or preserve an unwanted legacy behavior. |
| `PROP-C-DISPOSE-001` | Equality after one and repeated disposal can hide a leak present in both states. | Give every acquired effect a unique release counter and assert exactly one release per owner. | Counters observe registered effects only and can miss an unregistered side effect. |
| `PROP-C-ROLE-001` | The generated role-independent definition can omit a runtime assumption that still requires React. | Run headless and compound fixtures in a DOM-free process and run presentation fixtures in the browser harness, then compare their service and effect ledgers. | Different harnesses can hide a placement-specific defect or diverge in lifecycle timing. |
| `PROP-C-BOUNDARY-001` | Tripwires and the source graph can omit an indirect lifecycle or dependency edge. | Import the plugin in a fresh process that exposes public context fakes but has no Cordis package binding. | The isolated process can differ from bundler resolution in the packaged app. |

## Phase D: native providers

| Property | First-oracle failure mode | Alternative oracle | Alternative failure mode |
| --- | --- | --- | --- |
| `PROP-D-PARITY-001` | Legacy and extracted providers can share an external-tool or policy defect. | Compare both providers with reviewed semantic fixtures and explicit changed-behavior cases. | Fixtures cover fewer values and can become stale. |
| `PROP-D-AUTHORITY-001` | The rule-table model can encode a policy mistake. | Use denied canary resources and native audit traces to prove fail-closed behavior outside each generated scope. | Instrumentation can miss a bypass that does not emit the expected audit record. |
| `PROP-D-OWNERSHIP-001` | The ledger can classify a resource under the wrong owner. | Keep live terminal, watcher, and durable-data canaries across replacement and observe their stable native identities. | The canaries cover named resource types, not every future provider. |
| `PROP-D-CLOSURE-001` | Source graph configuration can omit a build or ACL projection. | Inspect the built Cargo metadata, Tauri ACL output, and packaged file inventory for the removed module identity. | Package inspection cannot find obsolete source that is no longer built. |

## Phase E: immutable artifacts

| Property | First-oracle failure mode | Alternative oracle | Alternative failure mode |
| --- | --- | --- | --- |
| `PROP-E-ARTIFACT-001` | Retained tuple normalization can repeat the packer's path or byte transformation. | Unpack with an independent archive reader and compare a separately constructed path-to-digest map. | Archive readers can differ on path normalization and metadata semantics. |
| `PROP-E-TAMPER-001` | Independent digest recomputation can still use the same covered-file list. | Mutate each indexed file and manifest field, then require native `modules preflight` to reject the archive. | The mutation set can miss an unindexed file that the runtime later loads. |
| `PROP-E-EXTERNALS-001` | Bundler metadata and runtime identity probes can omit an unexecuted chunk. | Inspect every emitted chunk and archive member for forbidden package signatures and imports. | Minification or generated wrappers can hide a dependency signature. |
| `PROP-E-MANIFEST-RUNTIME-001` | Native and browser collectors can share one mistaken schema interpretation. | Activate generated canary plugins that attempt every declared and undeclared contribution and service access. | Canary plugins can omit combinations or effects added by a later API version. |
| `PROP-E-BUILTIN-PARITY-001` | Catalog normalization can hide callback or interaction differences. | Run semantic command actions against separate fake hosts and compare visible result and ordered host-action logs. | The fake host cannot prove all packaged browser behavior. |
| `PROP-E-COMPATIBILITY-001` | The compatibility table can encode the wrong range or pre-release rule. | Differentially check generated tuples with a separately selected standards-compliant version-range library plus reviewed boundary fixtures. | A library can implement range syntax correctly while Shipctl's intended compatibility policy is wrong. |
| `PROP-E-HEADLESS-001` | The retained manifest and effect ledger can share the artifact loader's assumption about optional files. | Build a minimal artifact that has no React, CSS, asset, or view reference and exercise it through native preflight and the packaged application runtime. | One fixture cannot cover all valid headless service graphs or optional metadata combinations. |

## Phase F: live reconciliation

| Property | First-oracle failure mode | Alternative oracle | Alternative failure mode |
| --- | --- | --- | --- |
| `PROP-F-RECONCILE-001` | The pure graph model can omit a dependency or readiness rule. | Apply metamorphic histories that coalesce or permute irrelevant notifications and require the same accepted end state. | Metamorphic equality cannot identify which end state is semantically correct. |
| `PROP-F-ATOMIC-001` | Family digests can be computed after a partial state has already leaked elsewhere. | Place observers at command, menu, view, service, and workspace boundaries and synchronize them around the publication barrier. | A finite observer set can miss another consumer or a very short leak. |
| `PROP-F-REVISION-001` | A maximum-revision model can omit retry or rejection semantics. | Consume the live JSON watch trace and assert monotonic accepted and applied revision transitions. | Observation sampling can miss an internal rollback that is corrected before publication. |
| `PROP-F-CONTINUITY-001` | The host-resource ledger can encode the same wrong ownership classification. | Keep a PTY and another durable-resource canary alive and compare native identities and output across replacement. | Two canary types do not cover every durable resource. |
| `PROP-F-INSPECTION-001` | The command model can retain entities that were never visible in the real host. | Start from a visible contribution and follow only public snapshot links back to workspace, activation, artifact, grant, and lease records. | The probe proves reachable visible entities but not hidden orphan records. |
| `PROP-F-SERVICE-001` | The routing ledger can model publication points differently from the actual service proxy. | Use provider canaries with distinct immutable identities and record every consumer-observed identity around replacement and disposal barriers. | Canaries can miss an indirect cached provider reference held outside the checked consumer set. |
| `PROP-F-RESTART-001` | Cold-start and live reconciliation can share one faulty normalization or planner. | Build the expected accepted graph directly from admitted durable desired records. | The model can omit recovery metadata that users and agents require. |

## Phase G: workspace and closure

| Property | First-oracle failure mode | Alternative oracle | Alternative failure mode |
| --- | --- | --- | --- |
| `PROP-G-WORKSPACE-001` | The pure workspace model can copy a mistaken transition rule. | Validate every intermediate document and apply inverse semantic commands where an inverse is defined. | Schema validity is weaker than semantic correctness, and not every command has an inverse. |
| `PROP-G-RENDERER-001` | Projection normalization can hide a focus or action-routing defect. | Drive both adapters through independent user-action harnesses and compare semantic command traces and visible stable IDs. | DOM-driven checks can be fragile and do not prove pixel equality. |
| `PROP-G-LAYOUT-001` | Retained source and restored state can share one canonicalizer defect. | Compare the command-derived topology and identities before persistence with a schema-independent tree walk after restore. | The independent walk can omit renderer-specific state that product review later decides to preserve. |
| `PROP-G-CONTRIBUTION-CLEANUP-001` | The owner ledger can omit an effect that was never registered. | Use catalog, DOM stylesheet, command-route, subscription, and resource canaries after disposal. | Browser garbage collection is nondeterministic, and a finite canary set can omit a cache. |
| `PROP-G-ABSENCE-001` | The subset model can assume that the host remains operable without exercising it. | Build plug-out profiles and run core workspace operations with each selected module absent. | Static profiles do not prove live removal and exhaustive subsets can be expensive. |
| `PROP-G-CONTRIBUTION-SCHEMA-001` | A closed field model can omit a valid future semantic field or accept an aliased renderer value. | Add one forbidden renderer field to valid contributions and require admission to change from accept to reject. | Mutation names can lag new renderer-specific forms. |

## Selection and mutation rule

For each implementation task, reviewers select the first oracle, the
alternative, or both. The task record states the selection reason and the
remaining blind spot. The deliberate defect must target the selected oracle's
claimed boundary. If only one oracle detects it, the result is reviewed before
production work starts.

Changing the oracle, assumptions, generator domain, or runner configuration is
a test mutation. It follows the specification-first review order in document
05 and cannot be hidden inside a production fix.
