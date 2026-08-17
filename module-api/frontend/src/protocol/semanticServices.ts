import type { ModuleId } from "./panels";
import type { ModuleJsonValue } from "./services";

declare const activationIdBrand: unique symbol;
declare const correlationIdBrand: unique symbol;
declare const leaseIdBrand: unique symbol;
declare const streamAttachmentIdBrand: unique symbol;

/** One admitted execution of one module artifact. */
export type ModuleActivationId = string & { readonly [activationIdBrand]: true };

/** Stable identity for one bounded request and its diagnostic trace. */
export type SemanticCorrelationId = string & { readonly [correlationIdBrand]: true };

/** Stable identity for one event subscription owned by an activation. */
export type SemanticLeaseId = string & { readonly [leaseIdBrand]: true };

/** Stable identity for one ordered-stream attachment. */
export type SemanticStreamAttachmentId = string & {
  readonly [streamAttachmentIdBrand]: true;
};

export interface ModuleActivationIdentity {
  readonly moduleId: ModuleId;
  readonly activationId: ModuleActivationId;
}

/** A typed lookup key. It identifies a service, never an operation or IPC route. */
export interface SemanticServiceReference<Service> {
  readonly id: string;
  readonly version: number;
  readonly __service?: Service;
}

export function defineSemanticService<Service>(
  id: string,
  version: number,
): SemanticServiceReference<Service> {
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(id)) {
    throw new Error(`Invalid semantic service id: ${id}`);
  }
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(`Invalid semantic service version for ${id}: ${version}`);
  }
  return Object.freeze({ id, version });
}

export interface SemanticServiceAccess {
  has<Service>(reference: SemanticServiceReference<Service>): boolean;
  require<Service>(reference: SemanticServiceReference<Service>): Service;
}

export type SemanticCleanup = () => void | Promise<void>;

/** One early-releasable resource owned by an activation. */
export interface SemanticOwnedLease {
  readonly id: SemanticLeaseId;
  readonly activation: ModuleActivationIdentity;
  readonly disposed: boolean;
  dispose(): Promise<void>;
}

/** The public lifecycle and service view supplied to one module activation. */
export interface ModuleActivationContext {
  readonly identity: ModuleActivationIdentity;
  readonly services: SemanticServiceAccess;
  readonly disposed: boolean;
  own(cleanup: SemanticCleanup, backgroundEffectId?: string): SemanticOwnedLease;
}

export interface SemanticCancellation {
  readonly cancelled: boolean;
  subscribe(listener: () => void): SemanticOwnedLease;
}

export type SemanticRequestCancellation =
  | "unsupported"
  | "before-dispatch"
  | "cooperative";

export type SemanticRequestRetry =
  | { readonly kind: "never" }
  | {
      readonly kind: "idempotent";
      /** Required capability policy. The runtime supplies no implicit default. */
      readonly attempts: number;
    };

export interface SemanticRequestPolicy {
  readonly cancellation: SemanticRequestCancellation;
  readonly retry: SemanticRequestRetry;
}

export interface SemanticRequestOptions {
  readonly cancellation?: SemanticCancellation;
}

/** Stable failure meaning. The message is diagnostic text, not control flow. */
export interface SemanticServiceError<Code extends string = string> {
  readonly code: Code;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: ModuleJsonValue;
}

export type SemanticResult<Value, Code extends string = string> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: SemanticServiceError<Code> };

export interface SemanticRequestOutcome<Value, Code extends string = string> {
  readonly correlationId: SemanticCorrelationId;
  readonly result: SemanticResult<Value, Code>;
}

/** One named operation on a capability-specific service interface. */
export interface SemanticRequestOperation<
  Input,
  Output,
  ErrorCode extends string = string,
> {
  readonly policy: SemanticRequestPolicy;
  execute(
    input: Input,
    options?: SemanticRequestOptions,
  ): Promise<SemanticRequestOutcome<Output, ErrorCode>>;
}

export interface SemanticEventRecord<Event> {
  readonly sourceId: string;
  readonly sequence: number;
  readonly value: Event;
}

export interface SemanticEventLease {
  readonly id: SemanticLeaseId;
  readonly activation: ModuleActivationIdentity;
  readonly disposed: boolean;
  dispose(): Promise<void>;
}

/** A capability-specific service exposes a named instance of this source. */
export interface SemanticEventSource<Scope, Event> {
  subscribe(
    scope: Scope,
    listener: (event: SemanticEventRecord<Event>) => void | Promise<void>,
  ): Promise<SemanticEventLease>;
}

export interface SemanticStreamAttachRequest {
  /** Replay frames strictly after this sequence. Null requests live delivery only. */
  readonly afterSequence: number | null;
  readonly initialCredit: number;
}

export interface SemanticStreamFrame<Frame> {
  readonly type: "frame";
  readonly attachmentId: SemanticStreamAttachmentId;
  readonly sequence: number;
  readonly value: Frame;
}

export interface SemanticStreamGap {
  readonly type: "gap";
  readonly attachmentId: SemanticStreamAttachmentId;
  readonly requestedAfterSequence: number;
  readonly earliestAvailableSequence: number;
}

export interface SemanticStreamDisconnect {
  readonly type: "disconnected";
  readonly attachmentId: SemanticStreamAttachmentId;
  readonly reason: string;
  readonly resumable: boolean;
}

export type SemanticStreamDelivery<Frame> =
  | SemanticStreamFrame<Frame>
  | SemanticStreamGap
  | SemanticStreamDisconnect;

export interface SemanticStreamAttachment {
  readonly id: SemanticStreamAttachmentId;
  readonly activation: ModuleActivationIdentity;
  readonly disposed: boolean;
  readonly acknowledgedSequence: number | null;
  grant(credit: number): void;
  acknowledge(sequence: number): void;
  dispose(): Promise<void>;
}

/** Ordered, credit-controlled data. This is not a general event topic. */
export interface SemanticOrderedStream<Frame> {
  attach(
    request: SemanticStreamAttachRequest,
    listener: (delivery: SemanticStreamDelivery<Frame>) => void | Promise<void>,
  ): Promise<SemanticStreamAttachment>;
}
