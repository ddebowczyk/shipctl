export interface DesiredPluginIdentity {
  readonly moduleId: string;
  readonly version: string;
  readonly contentDigest: string;
}

export interface DesiredPluginSnapshot {
  readonly registryRevision: number;
  readonly modules: readonly DesiredPluginIdentity[];
}

export type ReconcileOperation =
  | { readonly kind: "add"; readonly desired: DesiredPluginIdentity }
  | {
    readonly kind: "replace";
    readonly applied: DesiredPluginIdentity;
    readonly desired: DesiredPluginIdentity;
  }
  | { readonly kind: "retain"; readonly desired: DesiredPluginIdentity }
  | { readonly kind: "remove"; readonly applied: DesiredPluginIdentity };

export interface ReconcilePlan {
  readonly fromRevision: number | null;
  readonly toRevision: number;
  readonly operations: readonly ReconcileOperation[];
  readonly changed: boolean;
}

export type ReconciliationStage =
  | "observe"
  | "prepare"
  | "validate"
  | "publish"
  | "dispose";

export interface ReconciliationDiagnostic {
  readonly code: string;
  readonly desiredRevision: number;
  readonly stage: ReconciliationStage;
  readonly message: string;
  readonly moduleId?: string;
  readonly activationId?: string;
}

/** A reconciliation failure with stable ownership for host diagnostics. */
export class RuntimeReconciliationError extends Error {
  readonly code: string;
  readonly moduleId?: string;
  readonly activationId?: string;
  readonly cause: unknown;

  constructor(
    code: string,
    message: string,
    identity: { readonly moduleId?: string; readonly activationId?: string } = {},
    cause?: unknown,
  ) {
    super(message);
    this.name = "RuntimeReconciliationError";
    this.code = code;
    this.moduleId = identity.moduleId;
    this.activationId = identity.activationId;
    this.cause = cause;
  }
}

export interface RuntimeCandidate<PublicFamily> {
  readonly desired: DesiredPluginSnapshot;
  readonly publicFamily: PublicFamily;
  validate(): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export interface AcceptedRuntime<PublicFamily> {
  readonly desired: DesiredPluginSnapshot;
  readonly publicFamily: PublicFamily;
  dispose(): void | Promise<void>;
}

export interface ReconciliationResult<PublicFamily> {
  readonly disposition: "applied" | "rejected" | "repeated" | "stale";
  readonly desiredRevision: number;
  readonly accepted: AcceptedRuntime<PublicFamily> | null;
  readonly diagnostic?: ReconciliationDiagnostic;
}

export interface LivePluginReconcilerOptions<PublicFamily> {
  prepare(
    desired: DesiredPluginSnapshot,
    plan: ReconcilePlan,
  ): Promise<RuntimeCandidate<PublicFamily>>;
  /** Commit external routes, then publish the family without another async boundary. */
  publish(
    candidate: RuntimeCandidate<PublicFamily>,
  ): AcceptedRuntime<PublicFamily> | Promise<AcceptedRuntime<PublicFamily>>;
  /** Advance registry truth without recreating an unchanged activation graph. */
  publishRetained?(
    accepted: AcceptedRuntime<PublicFamily>,
    desired: DesiredPluginSnapshot,
  ): AcceptedRuntime<PublicFamily>;
  describeError?(error: unknown): string;
}

function identityKey(identity: DesiredPluginIdentity): string {
  return `${identity.moduleId}@${identity.version}#${identity.contentDigest}`;
}

function indexedModules(
  snapshot: DesiredPluginSnapshot,
): ReadonlyMap<string, DesiredPluginIdentity> {
  if (!Number.isSafeInteger(snapshot.registryRevision) || snapshot.registryRevision < 0) {
    throw new Error("Desired registry revision must be a non-negative safe integer");
  }
  const modules = new Map<string, DesiredPluginIdentity>();
  for (const module of snapshot.modules) {
    if (module.moduleId.length === 0 || module.version.length === 0 || module.contentDigest.length === 0) {
      throw new Error("Desired plugin identity must contain module, version, and digest values");
    }
    if (modules.has(module.moduleId)) {
      throw new Error(`Desired plugin ${module.moduleId} appears more than once`);
    }
    modules.set(module.moduleId, module);
  }
  return modules;
}

export function normalizeDesiredPluginSnapshot(
  snapshot: DesiredPluginSnapshot,
): DesiredPluginSnapshot {
  const modules = [...indexedModules(snapshot).values()]
    .sort((left, right) => left.moduleId.localeCompare(right.moduleId));
  return Object.freeze({
    registryRevision: snapshot.registryRevision,
    modules: Object.freeze(modules.map((module) => Object.freeze({ ...module }))),
  });
}

export function planPluginReconciliation(
  applied: DesiredPluginSnapshot | null,
  desired: DesiredPluginSnapshot,
): ReconcilePlan {
  const normalizedDesired = normalizeDesiredPluginSnapshot(desired);
  const normalizedApplied = applied === null ? null : normalizeDesiredPluginSnapshot(applied);
  const previous = normalizedApplied === null
    ? new Map<string, DesiredPluginIdentity>()
    : indexedModules(normalizedApplied);
  const next = indexedModules(normalizedDesired);
  const operations: ReconcileOperation[] = [];

  for (const moduleId of [...new Set([...previous.keys(), ...next.keys()])].sort()) {
    const current = previous.get(moduleId);
    const candidate = next.get(moduleId);
    if (current === undefined && candidate !== undefined) {
      operations.push({ kind: "add", desired: candidate });
    } else if (current !== undefined && candidate === undefined) {
      operations.push({ kind: "remove", applied: current });
    } else if (current !== undefined && candidate !== undefined) {
      operations.push(identityKey(current) === identityKey(candidate)
        ? { kind: "retain", desired: candidate }
        : { kind: "replace", applied: current, desired: candidate });
    }
  }

  return Object.freeze({
    fromRevision: normalizedApplied?.registryRevision ?? null,
    toRevision: normalizedDesired.registryRevision,
    operations: Object.freeze(operations),
    changed: operations.some(({ kind }) => kind !== "retain"),
  });
}

function defaultErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Plugin reconciliation failed";
}

/**
 * Serializes desired revisions and keeps candidate work private until one
 * synchronous publication assignment. Cordis remains inside `prepare`; this
 * class owns desired/applied revision policy and last-good retention.
 */
export class LivePluginReconciler<PublicFamily> {
  readonly #options: LivePluginReconcilerOptions<PublicFamily>;
  #accepted: AcceptedRuntime<PublicFamily> | null = null;
  #highestSettledRevision = -1;
  #queue: Promise<unknown> = Promise.resolve();
  #diagnostics: ReconciliationDiagnostic[] = [];

  constructor(options: LivePluginReconcilerOptions<PublicFamily>) {
    this.#options = options;
  }

  get accepted(): AcceptedRuntime<PublicFamily> | null {
    return this.#accepted;
  }

  get diagnostics(): readonly ReconciliationDiagnostic[] {
    return [...this.#diagnostics];
  }

  reconcile(desired: DesiredPluginSnapshot): Promise<ReconciliationResult<PublicFamily>> {
    const scheduled = this.#queue.then(() => this.#reconcile(desired));
    this.#queue = scheduled.catch(() => undefined);
    return scheduled;
  }

  async settled(): Promise<void> {
    await this.#queue;
  }

  async dispose(): Promise<void> {
    await this.#queue;
    const accepted = this.#accepted;
    this.#accepted = null;
    await accepted?.dispose();
  }

  async #reconcile(
    desiredInput: DesiredPluginSnapshot,
  ): Promise<ReconciliationResult<PublicFamily>> {
    let desired: DesiredPluginSnapshot;
    try {
      desired = normalizeDesiredPluginSnapshot(desiredInput);
    } catch (error) {
      const diagnostic = this.#diagnostic(desiredInput.registryRevision, "observe", error);
      return {
        disposition: "rejected",
        desiredRevision: desiredInput.registryRevision,
        accepted: this.#accepted,
        diagnostic,
      };
    }

    const acceptedRevision = this.#accepted?.desired.registryRevision ?? -1;
    if (desired.registryRevision < this.#highestSettledRevision
      || desired.registryRevision < acceptedRevision) {
      return {
        disposition: "stale",
        desiredRevision: desired.registryRevision,
        accepted: this.#accepted,
      };
    }
    if (desired.registryRevision === this.#highestSettledRevision) {
      return {
        disposition: "repeated",
        desiredRevision: desired.registryRevision,
        accepted: this.#accepted,
      };
    }

    const plan = planPluginReconciliation(this.#accepted?.desired ?? null, desired);
    if (!plan.changed && this.#accepted !== null) {
      const previous = this.#accepted;
      const accepted = this.#options.publishRetained?.(previous, desired) ?? {
        desired,
        publicFamily: previous.publicFamily,
        dispose: () => previous.dispose(),
      };
      this.#accepted = accepted;
      this.#highestSettledRevision = desired.registryRevision;
      return {
        disposition: "applied",
        desiredRevision: desired.registryRevision,
        accepted,
      };
    }
    let candidate: RuntimeCandidate<PublicFamily> | null = null;
    try {
      candidate = await this.#options.prepare(desired, plan);
    } catch (error) {
      await candidate?.dispose();
      this.#highestSettledRevision = Math.max(this.#highestSettledRevision, desired.registryRevision);
      const diagnostic = this.#diagnostic(desired.registryRevision, "prepare", error);
      return {
        disposition: "rejected",
        desiredRevision: desired.registryRevision,
        accepted: this.#accepted,
        diagnostic,
      };
    }
    try {
      await candidate.validate();
    } catch (error) {
      await candidate.dispose();
      this.#highestSettledRevision = Math.max(this.#highestSettledRevision, desired.registryRevision);
      const diagnostic = this.#diagnostic(desired.registryRevision, "validate", error);
      return {
        disposition: "rejected",
        desiredRevision: desired.registryRevision,
        accepted: this.#accepted,
        diagnostic,
      };
    }

    let accepted: AcceptedRuntime<PublicFamily>;
    try {
      accepted = await this.#options.publish(candidate);
    } catch (error) {
      await candidate.dispose();
      this.#highestSettledRevision = Math.max(this.#highestSettledRevision, desired.registryRevision);
      const diagnostic = this.#diagnostic(desired.registryRevision, "publish", error);
      return {
        disposition: "rejected",
        desiredRevision: desired.registryRevision,
        accepted: this.#accepted,
        diagnostic,
      };
    }

    const predecessor = this.#accepted;
    this.#accepted = accepted;
    this.#highestSettledRevision = desired.registryRevision;
    let diagnostic: ReconciliationDiagnostic | undefined;
    try {
      await predecessor?.dispose();
    } catch (error) {
      diagnostic = this.#diagnostic(desired.registryRevision, "dispose", error);
    }
    return {
      disposition: "applied",
      desiredRevision: desired.registryRevision,
      accepted,
      ...(diagnostic === undefined ? {} : { diagnostic }),
    };
  }

  #diagnostic(
    desiredRevision: number,
    stage: ReconciliationStage,
    error: unknown,
  ): ReconciliationDiagnostic {
    const ownedFailure = error instanceof RuntimeReconciliationError ? error : null;
    const diagnostic = Object.freeze({
      code: ownedFailure?.code ?? "module.runtime.reconciliation_failed",
      desiredRevision,
      stage,
      message: this.#options.describeError?.(error) ?? defaultErrorMessage(error),
      ...(ownedFailure?.moduleId === undefined ? {} : { moduleId: ownedFailure.moduleId }),
      ...(ownedFailure?.activationId === undefined
        ? {}
        : { activationId: ownedFailure.activationId }),
    });
    this.#diagnostics.push(diagnostic);
    return diagnostic;
  }
}

/** An observable family whose snapshot and service routes change together. */
export class AtomicRuntimePublication<PublicFamily> {
  #current: PublicFamily;
  readonly #listeners = new Set<() => void>();

  constructor(initial: PublicFamily) {
    this.#current = initial;
  }

  getSnapshot = (): PublicFamily => this.#current;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  publish(family: PublicFamily): void {
    this.#current = family;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        if (import.meta.env.DEV) {
          console.error("A runtime publication listener failed:", error);
        }
      }
    }
  }
}
