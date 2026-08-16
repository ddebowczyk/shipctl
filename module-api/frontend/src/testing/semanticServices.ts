import type { ModuleId } from "../protocol/panels";
import type {
  ModuleActivationContext,
  ModuleActivationId,
  ModuleActivationIdentity,
  SemanticCancellation,
  SemanticCleanup,
  SemanticCorrelationId,
  SemanticEventLease,
  SemanticEventRecord,
  SemanticEventSource,
  SemanticLeaseId,
  SemanticOrderedStream,
  SemanticOwnedLease,
  SemanticRequestOperation,
  SemanticRequestPolicy,
  SemanticServiceAccess,
  SemanticServiceError,
  SemanticServiceReference,
  SemanticStreamAttachRequest,
  SemanticStreamAttachment,
  SemanticStreamAttachmentId,
  SemanticStreamDelivery,
  SemanticStreamFrame,
} from "../protocol/semanticServices";
import type {
  AnySemanticServiceProvider,
  SemanticServiceProviderContext,
} from "../host/semanticServices";

function key(reference: SemanticServiceReference<unknown>): string {
  return `${reference.id}@${reference.version}`;
}

let nextTestIdentity = 1;

function testIdentity(prefix: string): string {
  const value = nextTestIdentity;
  nextTestIdentity += 1;
  return `${prefix}#${value}`;
}

export function createTestActivationIdentity(
  moduleId: string,
  activationId: string = testIdentity(moduleId),
): ModuleActivationIdentity {
  return {
    moduleId: moduleId as ModuleId,
    activationId: activationId as ModuleActivationId,
  };
}

class TestOwnedLease implements SemanticOwnedLease {
  readonly id = testIdentity("lease") as SemanticLeaseId;
  readonly activation: ModuleActivationIdentity;
  #cleanup: SemanticCleanup | null;

  constructor(activation: ModuleActivationIdentity, cleanup: SemanticCleanup) {
    this.activation = activation;
    this.#cleanup = cleanup;
  }

  get disposed(): boolean {
    return this.#cleanup === null;
  }

  async dispose(): Promise<void> {
    const cleanup = this.#cleanup;
    if (cleanup === null) return;
    this.#cleanup = null;
    await cleanup();
  }
}

export interface TestActivationController {
  readonly context: ModuleActivationContext;
  dispose(): Promise<void>;
}

class TestActivation implements TestActivationController {
  readonly #providers: ReadonlyMap<string, AnySemanticServiceProvider>;
  readonly #instances = new Map<string, unknown>();
  readonly #leases: TestOwnedLease[] = [];
  #disposed = false;
  readonly context: ModuleActivationContext;

  constructor(
    identity: ModuleActivationIdentity,
    providers: ReadonlyMap<string, AnySemanticServiceProvider>,
  ) {
    this.#providers = providers;
    const access: SemanticServiceAccess = {
      has: (reference) => !this.#disposed && this.#providers.has(key(reference)),
      require: <Service>(reference: SemanticServiceReference<Service>): Service => {
        this.#assertActive(identity);
        const serviceKey = key(reference);
        if (this.#instances.has(serviceKey)) return this.#instances.get(serviceKey) as Service;
        const provider = this.#providers.get(serviceKey);
        if (!provider) throw new Error(`Semantic service ${serviceKey} is unavailable`);
        const activation = this;
        const providerContext: SemanticServiceProviderContext = {
          activation: identity,
          get active() { return !activation.#disposed; },
          own: (cleanup) => this.#own(identity, cleanup),
        };
        const instance = provider.bind(providerContext);
        this.#instances.set(serviceKey, instance);
        return instance as Service;
      },
    };
    const activation = this;
    this.context = Object.freeze({
      identity,
      services: Object.freeze(access),
      get disposed() { return activation.#disposed; },
      own: (cleanup: SemanticCleanup) => this.#own(identity, cleanup),
    });
  }

  #assertActive(identity: ModuleActivationIdentity): void {
    if (this.#disposed) throw new Error(`Test activation ${identity.activationId} is disposed`);
  }

  #own(
    identity: ModuleActivationIdentity,
    cleanup: SemanticCleanup,
  ): SemanticOwnedLease {
    this.#assertActive(identity);
    const lease = new TestOwnedLease(identity, cleanup);
    this.#leases.push(lease);
    return lease;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const lease of [...this.#leases].reverse()) await lease.dispose();
    this.#instances.clear();
  }
}

/** DOM-free and Tauri-free host for module workflow and contract tests. */
export class SemanticServiceTestHost {
  readonly #providers: ReadonlyMap<string, AnySemanticServiceProvider>;
  readonly #seen = new Set<ModuleActivationId>();

  constructor(providers: readonly AnySemanticServiceProvider[] = []) {
    const indexed = new Map<string, AnySemanticServiceProvider>();
    for (const provider of providers) {
      const serviceKey = key(provider.service);
      if (indexed.has(serviceKey)) throw new Error(`Duplicate semantic service provider: ${serviceKey}`);
      indexed.set(serviceKey, provider);
    }
    this.#providers = indexed;
  }

  activate(identity: ModuleActivationIdentity): TestActivationController {
    if (this.#seen.has(identity.activationId)) {
      throw new Error(`Test activation identity cannot be reused: ${identity.activationId}`);
    }
    this.#seen.add(identity.activationId);
    return new TestActivation(identity, this.#providers);
  }
}

export interface FakeRequestTrace<Input> {
  readonly activation: ModuleActivationIdentity;
  readonly correlationId: SemanticCorrelationId;
  readonly input: Input;
}

export interface FakeRequestOptions<Input, Output, ErrorCode extends string> {
  readonly context: SemanticServiceProviderContext;
  readonly policy: SemanticRequestPolicy;
  readonly handle: (trace: FakeRequestTrace<Input>) => Output | Promise<Output>;
  readonly failedError: (error: unknown) => SemanticServiceError<ErrorCode>;
  readonly cancelledError: SemanticServiceError<ErrorCode>;
  readonly disposedError: SemanticServiceError<ErrorCode>;
  readonly trace?: FakeRequestTrace<Input>[];
}

export function createFakeRequestOperation<Input, Output, ErrorCode extends string>(
  options: FakeRequestOptions<Input, Output, ErrorCode>,
): SemanticRequestOperation<Input, Output, ErrorCode> {
  return {
    policy: options.policy,
    async execute(input, requestOptions) {
      const correlationId = testIdentity("request") as SemanticCorrelationId;
      if (!options.context.active) {
        return { correlationId, result: { ok: false, error: options.disposedError } };
      }
      if (
        requestOptions?.cancellation?.cancelled
        && options.policy.cancellation !== "unsupported"
      ) {
        return { correlationId, result: { ok: false, error: options.cancelledError } };
      }
      const trace = { activation: options.context.activation, correlationId, input };
      options.trace?.push(trace);
      try {
        return {
          correlationId,
          result: { ok: true, value: await options.handle(trace) },
        };
      } catch (error) {
        return {
          correlationId,
          result: { ok: false, error: options.failedError(error) },
        };
      }
    },
  };
}

export class TestCancellation implements SemanticCancellation {
  readonly #context: ModuleActivationContext;
  readonly #listeners = new Set<() => void>();
  #cancelled = false;

  constructor(context: ModuleActivationContext) {
    this.#context = context;
  }

  get cancelled(): boolean {
    return this.#cancelled;
  }

  subscribe(listener: () => void): SemanticOwnedLease {
    if (this.#cancelled) listener();
    this.#listeners.add(listener);
    return this.#context.own(() => { this.#listeners.delete(listener); });
  }

  cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    for (const listener of this.#listeners) listener();
  }
}

interface EventSubscription<Scope, Event> {
  readonly scope: Scope;
  readonly listener: (event: SemanticEventRecord<Event>) => void | Promise<void>;
  readonly lease: SemanticOwnedLease;
}

export class TestEventSource<Scope, Event> implements SemanticEventSource<Scope, Event> {
  readonly #context: SemanticServiceProviderContext;
  readonly #sourceId: string;
  readonly #sameScope: (left: Scope, right: Scope) => boolean;
  readonly #subscriptions = new Set<EventSubscription<Scope, Event>>();
  #sequence = 0;
  #queue: Promise<void> = Promise.resolve();

  constructor(
    context: SemanticServiceProviderContext,
    sourceId: string,
    sameScope: (left: Scope, right: Scope) => boolean,
  ) {
    this.#context = context;
    this.#sourceId = sourceId;
    this.#sameScope = sameScope;
  }

  async subscribe(
    scope: Scope,
    listener: (event: SemanticEventRecord<Event>) => void | Promise<void>,
  ): Promise<SemanticEventLease> {
    if (!this.#context.active) throw new Error("Cannot subscribe from a disposed activation");
    let subscription: EventSubscription<Scope, Event>;
    const lease = this.#context.own(() => { this.#subscriptions.delete(subscription); });
    subscription = { scope, listener, lease };
    this.#subscriptions.add(subscription);
    return lease;
  }

  publish(scope: Scope, value: Event): Promise<void> {
    this.#sequence += 1;
    const event = { sourceId: this.#sourceId, sequence: this.#sequence, value };
    const deliveries = [...this.#subscriptions].filter(
      (subscription) => !subscription.lease.disposed
        && this.#sameScope(subscription.scope, scope),
    );
    this.#queue = this.#queue.then(async () => {
      for (const subscription of deliveries) {
        if (!subscription.lease.disposed) await subscription.listener(event);
      }
    });
    return this.#queue;
  }

  settled(): Promise<void> {
    return this.#queue;
  }
}

interface RetainedFrame<Frame> {
  readonly sequence: number;
  readonly value: Frame;
}

class TestStreamAttachment<Frame> implements SemanticStreamAttachment {
  readonly id = testIdentity("attachment") as SemanticStreamAttachmentId;
  readonly activation: ModuleActivationIdentity;
  readonly #listener: (
    delivery: SemanticStreamDelivery<Frame>,
  ) => void | Promise<void>;
  readonly #owned: SemanticOwnedLease;
  readonly #pending: RetainedFrame<Frame>[] = [];
  #credit: number;
  #acknowledgedSequence: number | null = null;
  #lastDeliveredSequence: number | null = null;
  #queue: Promise<void> = Promise.resolve();
  #disconnected = false;

  constructor(
    context: SemanticServiceProviderContext,
    initialCredit: number,
    listener: (delivery: SemanticStreamDelivery<Frame>) => void | Promise<void>,
    remove: () => void,
  ) {
    this.activation = context.activation;
    this.#credit = initialCredit;
    this.#listener = listener;
    this.#owned = context.own(remove);
  }

  get disposed(): boolean {
    return this.#owned.disposed;
  }

  get acknowledgedSequence(): number | null {
    return this.#acknowledgedSequence;
  }

  enqueue(frame: RetainedFrame<Frame>): void {
    if (this.disposed || this.#disconnected) return;
    this.#pending.push(frame);
    this.#drain();
  }

  deliver(delivery: SemanticStreamDelivery<Frame>): Promise<void> {
    this.#queue = this.#queue.then(async () => {
      if (!this.disposed) await this.#listener(delivery);
    });
    return this.#queue;
  }

  grant(credit: number): void {
    if (!Number.isSafeInteger(credit) || credit < 1) {
      throw new Error("Stream credit must be a positive safe integer");
    }
    if (this.disposed || this.#disconnected) return;
    this.#credit += credit;
    this.#drain();
  }

  acknowledge(sequence: number): void {
    if (
      !Number.isSafeInteger(sequence)
      || this.#lastDeliveredSequence === null
      || sequence > this.#lastDeliveredSequence
      || (this.#acknowledgedSequence !== null && sequence < this.#acknowledgedSequence)
    ) {
      throw new Error("Stream acknowledgement is outside the delivered sequence");
    }
    this.#acknowledgedSequence = sequence;
  }

  async disconnect(reason: string, resumable: boolean): Promise<void> {
    if (this.disposed || this.#disconnected) return;
    this.#disconnected = true;
    await this.deliver({
      type: "disconnected",
      attachmentId: this.id,
      reason,
      resumable,
    });
    await this.dispose();
  }

  settled(): Promise<void> {
    return this.#queue;
  }

  dispose(): Promise<void> {
    return this.#owned.dispose();
  }

  #drain(): void {
    while (this.#credit > 0 && this.#pending.length > 0) {
      const frame = this.#pending.shift();
      if (!frame) return;
      this.#credit -= 1;
      this.#lastDeliveredSequence = frame.sequence;
      void this.deliver({
        type: "frame",
        attachmentId: this.id,
        sequence: frame.sequence,
        value: frame.value,
      });
    }
  }
}

export class TestOrderedStreamSource<Frame> implements SemanticOrderedStream<Frame> {
  readonly #context: SemanticServiceProviderContext;
  readonly #retainedFrameCount: number;
  readonly #retained: RetainedFrame<Frame>[] = [];
  readonly #attachments = new Set<TestStreamAttachment<Frame>>();
  #sequence = 0;

  constructor(context: SemanticServiceProviderContext, retainedFrameCount: number) {
    if (!Number.isSafeInteger(retainedFrameCount) || retainedFrameCount < 0) {
      throw new Error("Retained frame count must be a non-negative safe integer");
    }
    this.#context = context;
    this.#retainedFrameCount = retainedFrameCount;
  }

  async attach(
    request: SemanticStreamAttachRequest,
    listener: (delivery: SemanticStreamDelivery<Frame>) => void | Promise<void>,
  ): Promise<SemanticStreamAttachment> {
    if (!this.#context.active) throw new Error("Cannot attach from a disposed activation");
    if (!Number.isSafeInteger(request.initialCredit) || request.initialCredit < 0) {
      throw new Error("Initial stream credit must be a non-negative safe integer");
    }
    if (
      request.afterSequence !== null
      && (!Number.isSafeInteger(request.afterSequence) || request.afterSequence < 0)
    ) {
      throw new Error("Replay sequence must be a non-negative safe integer or null");
    }
    let attachment: TestStreamAttachment<Frame>;
    attachment = new TestStreamAttachment(
      this.#context,
      request.initialCredit,
      listener,
      () => { this.#attachments.delete(attachment); },
    );
    this.#attachments.add(attachment);
    if (request.afterSequence !== null) {
      const earliest = this.#retained[0]?.sequence ?? this.#sequence + 1;
      if (request.afterSequence < this.#sequence && request.afterSequence < earliest - 1) {
        await attachment.deliver({
          type: "gap",
          attachmentId: attachment.id,
          requestedAfterSequence: request.afterSequence,
          earliestAvailableSequence: earliest,
        });
      }
      for (const frame of this.#retained) {
        if (frame.sequence > request.afterSequence) attachment.enqueue(frame);
      }
    }
    await attachment.settled();
    return attachment;
  }

  async append(value: Frame): Promise<number> {
    this.#sequence += 1;
    const frame = { sequence: this.#sequence, value };
    this.#retained.push(frame);
    while (this.#retained.length > this.#retainedFrameCount) this.#retained.shift();
    for (const attachment of this.#attachments) attachment.enqueue(frame);
    await this.settled();
    return frame.sequence;
  }

  async disconnect(reason: string, resumable: boolean): Promise<void> {
    await Promise.all(
      [...this.#attachments].map((attachment) => attachment.disconnect(reason, resumable)),
    );
  }

  async settled(): Promise<void> {
    await Promise.all([...this.#attachments].map((attachment) => attachment.settled()));
  }
}
