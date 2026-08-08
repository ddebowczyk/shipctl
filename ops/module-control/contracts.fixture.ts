// Checked mirror of core/backend/src/module_control/contracts.rs.
// The Rust parser owns schema-version and semantic validation; this file keeps
// the supervisor-facing JSON field names and tagged values aligned.

type SchemaVersion = number;
type ModuleSource = "bundled" | "user" | "development";
type ModuleRuntimeKind =
  | "frontend_esm"
  | "static_builtin"
  | "precompiled_host_adapter"
  | "worker"
  | "wasm"
  | "native_registration";
type ModuleLifecycleState =
  | "disabled"
  | "preparing"
  | "active"
  | "draining"
  | "failed"
  | "unavailable"
  | "restart_required";
type DiagnosticSeverity = "info" | "warning" | "error";
type ResourceDrainState = "active" | "draining" | "released" | "blocked";
type ModuleOperationKind =
  | "add"
  | "enable"
  | "update"
  | "disable"
  | "remove"
  | "rollback"
  | "reconfigure"
  | "apply";
type ModuleOperationPhase =
  | "received"
  | "preflight"
  | "committed"
  | "reconciling"
  | "published"
  | "draining"
  | "completed"
  | "failed";
type ModuleOperationResult = "pending" | "succeeded" | "failed";

interface ModuleIdentity {
  readonly schemaVersion: SchemaVersion;
  readonly id: string;
  readonly version: string;
  readonly contentDigest: string;
  readonly source: ModuleSource;
  readonly runtimeKind: ModuleRuntimeKind;
}

interface DesiredModuleState {
  readonly schemaVersion: SchemaVersion;
  readonly moduleId: string;
  readonly instanceId: string;
  readonly selectedArtifact: ModuleIdentity | null;
  readonly enabled: boolean;
  readonly configurationRevision: number;
}

interface ObservedModuleState {
  readonly schemaVersion: SchemaVersion;
  readonly moduleId: string;
  readonly instanceId: string;
  readonly artifact?: ModuleIdentity;
  readonly appliedRegistryRevision: number;
  readonly lifecycle: ModuleLifecycleState;
  readonly moduleInstanceId?: string;
}

interface Diagnostic {
  readonly schemaVersion: SchemaVersion;
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly check: string;
  readonly summary: string;
  readonly evidence: { readonly fields?: Readonly<Record<string, string>> };
  readonly remedy?: string;
}

interface ResourceLease {
  readonly schemaVersion: SchemaVersion;
  readonly ownerInstanceId: string;
  readonly ownerShipctlInstanceId: string;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly drainState: ResourceDrainState;
}

interface ModuleInspection {
  readonly schemaVersion: SchemaVersion;
  readonly manifest: ModuleIdentity;
  readonly desired: DesiredModuleState;
  readonly observed: readonly ObservedModuleState[];
  readonly grants: readonly { readonly id: string; readonly effective: boolean }[];
  readonly contributions: readonly {
    readonly id: string;
    readonly kind: string;
    readonly ownerInstanceId?: string;
  }[];
  readonly leases: readonly ResourceLease[];
  readonly diagnostics: readonly Diagnostic[];
}

interface ModuleOperation {
  readonly schemaVersion: SchemaVersion;
  readonly requestId: string;
  readonly moduleId: string;
  readonly instanceId: string;
  readonly kind: ModuleOperationKind;
  readonly targetRegistryRevision: number;
  readonly transitions: readonly {
    readonly phase: ModuleOperationPhase;
    readonly registryRevision?: number;
    readonly diagnostics?: readonly Diagnostic[];
  }[];
  readonly result: ModuleOperationResult;
}

interface VerificationExpectation {
  readonly schemaVersion: SchemaVersion;
  readonly fixtureId: string;
  readonly moduleId: string;
  readonly instanceId: string;
  readonly expectedEnabled?: boolean;
  readonly expectedArtifactDigest?: string;
  readonly expectedConfigurationRevision?: number;
  readonly expectedAppliedRegistryRevision?: number;
  readonly expectedLifecycle?: ModuleLifecycleState;
  readonly expectedDiagnosticCodes: readonly string[];
}

interface VerificationResult {
  readonly schemaVersion: SchemaVersion;
  readonly fixtureId: string;
  readonly expected: VerificationExpectation;
  readonly observed: {
    readonly inspection?: ModuleInspection;
    readonly diagnosticCodes: readonly string[];
  };
  readonly matched: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly resolvedPaths: Readonly<Record<string, string>>;
  readonly artifactMarkers: Readonly<Record<string, string>>;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
}

function number(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number") throw new TypeError(`${name} must be a number`);
}

function boolean(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
}

function array(value: unknown, name: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new TypeError(`${name} has an unsupported value`);
  }
}

function identity(value: unknown, name: string): asserts value is ModuleIdentity {
  const source = record(value, name);
  number(source.schemaVersion, `${name}.schemaVersion`);
  string(source.id, `${name}.id`);
  string(source.version, `${name}.version`);
  string(source.contentDigest, `${name}.contentDigest`);
  oneOf(source.source, ["bundled", "user", "development"], `${name}.source`);
  oneOf(
    source.runtimeKind,
    ["frontend_esm", "static_builtin", "precompiled_host_adapter", "worker", "wasm", "native_registration"],
    `${name}.runtimeKind`,
  );
}

function diagnostic(value: unknown, name: string): asserts value is Diagnostic {
  const source = record(value, name);
  number(source.schemaVersion, `${name}.schemaVersion`);
  string(source.code, `${name}.code`);
  oneOf(source.severity, ["info", "warning", "error"], `${name}.severity`);
  string(source.check, `${name}.check`);
  string(source.summary, `${name}.summary`);
  const evidence = record(source.evidence, `${name}.evidence`);
  if (evidence.fields !== undefined) {
    for (const [key, field] of Object.entries(record(evidence.fields, `${name}.evidence.fields`))) {
      string(field, `${name}.evidence.fields.${key}`);
    }
  }
  if (source.remedy !== undefined) string(source.remedy, `${name}.remedy`);
}

function desired(value: unknown, name: string): asserts value is DesiredModuleState {
  const source = record(value, name);
  number(source.schemaVersion, `${name}.schemaVersion`);
  string(source.moduleId, `${name}.moduleId`);
  string(source.instanceId, `${name}.instanceId`);
  if (source.selectedArtifact !== null) identity(source.selectedArtifact, `${name}.selectedArtifact`);
  boolean(source.enabled, `${name}.enabled`);
  number(source.configurationRevision, `${name}.configurationRevision`);
}

function observed(value: unknown, name: string): asserts value is ObservedModuleState {
  const source = record(value, name);
  number(source.schemaVersion, `${name}.schemaVersion`);
  string(source.moduleId, `${name}.moduleId`);
  string(source.instanceId, `${name}.instanceId`);
  if (source.artifact !== undefined) identity(source.artifact, `${name}.artifact`);
  number(source.appliedRegistryRevision, `${name}.appliedRegistryRevision`);
  oneOf(source.lifecycle, ["disabled", "preparing", "active", "draining", "failed", "unavailable", "restart_required"], `${name}.lifecycle`);
  if (source.moduleInstanceId !== undefined) string(source.moduleInstanceId, `${name}.moduleInstanceId`);
}

function grant(value: unknown, name: string): void {
  const source = record(value, name);
  string(source.id, `${name}.id`);
  boolean(source.effective, `${name}.effective`);
}

function contribution(value: unknown, name: string): void {
  const source = record(value, name);
  string(source.id, `${name}.id`);
  string(source.kind, `${name}.kind`);
  if (source.ownerInstanceId !== undefined) string(source.ownerInstanceId, `${name}.ownerInstanceId`);
}

function lease(value: unknown, name: string): void {
  const source = record(value, name);
  number(source.schemaVersion, `${name}.schemaVersion`);
  string(source.ownerInstanceId, `${name}.ownerInstanceId`);
  string(source.ownerShipctlInstanceId, `${name}.ownerShipctlInstanceId`);
  string(source.resourceKind, `${name}.resourceKind`);
  string(source.resourceId, `${name}.resourceId`);
  oneOf(source.drainState, ["active", "draining", "released", "blocked"], `${name}.drainState`);
}

export function assertModuleInspection(value: unknown): asserts value is ModuleInspection {
  const source = record(value, "inspection");
  number(source.schemaVersion, "inspection.schemaVersion");
  identity(source.manifest, "inspection.manifest");
  desired(source.desired, "inspection.desired");
  for (const [name, check] of [["observed", observed], ["diagnostics", diagnostic]] as const) {
    array(source[name], `inspection.${name}`);
    source[name].forEach((entry, index) => check(entry, `inspection.${name}[${index}]`));
  }
  for (const [name, check] of [["grants", grant], ["contributions", contribution], ["leases", lease]] as const) {
    array(source[name], `inspection.${name}`);
    source[name].forEach((entry, index) => check(entry, `inspection.${name}[${index}]`));
  }
}

export function assertModuleOperation(value: unknown): asserts value is ModuleOperation {
  const source = record(value, "operation");
  number(source.schemaVersion, "operation.schemaVersion");
  string(source.requestId, "operation.requestId");
  string(source.moduleId, "operation.moduleId");
  string(source.instanceId, "operation.instanceId");
  oneOf(source.kind, ["add", "enable", "update", "disable", "remove", "rollback", "reconfigure", "apply"], "operation.kind");
  number(source.targetRegistryRevision, "operation.targetRegistryRevision");
  array(source.transitions, "operation.transitions");
  source.transitions.forEach((transition, index) => {
    const item = record(transition, `operation.transitions[${index}]`);
    oneOf(item.phase, ["received", "preflight", "committed", "reconciling", "published", "draining", "completed", "failed"], `operation.transitions[${index}].phase`);
    if (item.registryRevision !== undefined) number(item.registryRevision, `operation.transitions[${index}].registryRevision`);
    if (item.diagnostics !== undefined) {
      array(item.diagnostics, `operation.transitions[${index}].diagnostics`);
      item.diagnostics.forEach((entry, diagnosticIndex) => diagnostic(entry, `operation.transitions[${index}].diagnostics[${diagnosticIndex}]`));
    }
  });
  oneOf(source.result, ["pending", "succeeded", "failed"], "operation.result");
}

export function assertVerificationResult(value: unknown): asserts value is VerificationResult {
  const source = record(value, "verification");
  number(source.schemaVersion, "verification.schemaVersion");
  string(source.fixtureId, "verification.fixtureId");
  const expectation = record(source.expected, "verification.expected");
  number(expectation.schemaVersion, "verification.expected.schemaVersion");
  string(expectation.fixtureId, "verification.expected.fixtureId");
  string(expectation.moduleId, "verification.expected.moduleId");
  string(expectation.instanceId, "verification.expected.instanceId");
  if (expectation.expectedEnabled !== undefined) boolean(expectation.expectedEnabled, "verification.expected.expectedEnabled");
  if (expectation.expectedArtifactDigest !== undefined) string(expectation.expectedArtifactDigest, "verification.expected.expectedArtifactDigest");
  if (expectation.expectedConfigurationRevision !== undefined) number(expectation.expectedConfigurationRevision, "verification.expected.expectedConfigurationRevision");
  if (expectation.expectedAppliedRegistryRevision !== undefined) number(expectation.expectedAppliedRegistryRevision, "verification.expected.expectedAppliedRegistryRevision");
  if (expectation.expectedLifecycle !== undefined) {
    oneOf(expectation.expectedLifecycle, ["disabled", "preparing", "active", "draining", "failed", "unavailable", "restart_required"], "verification.expected.expectedLifecycle");
  }
  array(expectation.expectedDiagnosticCodes, "verification.expected.expectedDiagnosticCodes");
  expectation.expectedDiagnosticCodes.forEach((code, index) => string(code, `verification.expected.expectedDiagnosticCodes[${index}]`));
  const observedValue = record(source.observed, "verification.observed");
  if (observedValue.inspection !== undefined) assertModuleInspection(observedValue.inspection);
  array(observedValue.diagnosticCodes, "verification.observed.diagnosticCodes");
  boolean(source.matched, "verification.matched");
  array(source.diagnostics, "verification.diagnostics");
  source.diagnostics.forEach((entry, index) => diagnostic(entry, `verification.diagnostics[${index}]`));
  for (const [name, values] of [["resolvedPaths", source.resolvedPaths], ["artifactMarkers", source.artifactMarkers]] as const) {
    for (const [key, entry] of Object.entries(record(values, `verification.${name}`))) {
      string(entry, `verification.${name}.${key}`);
    }
  }
}
