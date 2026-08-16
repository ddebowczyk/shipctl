import {
  SCHEDULER_REGISTER_GRANT,
  SCHEDULER_SERVICE_ERROR_CODES,
  SCHEDULER_SERVICE_SCHEMA_VERSION,
  schedulerService,
  type InspectSchedulesInput,
  type RegisterScheduleInput,
  type ScheduledDeliveryEvent,
  type ScheduleLease,
  type ScheduleLeaseInspection,
  type SchedulerService,
  type SchedulerServiceErrorCode,
} from "../protocol/schedules.ts";
import type {
  SemanticEventLease,
  SemanticEventRecord,
  SemanticOwnedLease,
  SemanticServiceError,
} from "../protocol/semanticServices.ts";
import type {
  SemanticServiceProvider,
  SemanticServiceProviderContext,
} from "../host/semanticServices.ts";

import {
  createFakeRequestOperation,
  type FakeRequestTrace,
} from "./semanticServices.ts";

export type FakeSchedulerOperation = "register" | "inspect";

export interface FakeSchedulerTrace {
  readonly operation: FakeSchedulerOperation;
  readonly request: FakeRequestTrace<RegisterScheduleInput<unknown> | InspectSchedulesInput>;
}

export interface FakeSchedulerDelivery {
  readonly outcome: "delivered" | "failed";
  readonly routeGeneration: number;
}

export interface FakeSchedulerProviderOptions {
  readonly clock?: FakeSchedulerClock;
  readonly deniedGrants?: readonly string[];
  readonly trace?: FakeSchedulerTrace[];
  readonly deliver?: (
    input: RegisterScheduleInput<unknown>,
    occurrenceUtc: string,
  ) => FakeSchedulerDelivery | Promise<FakeSchedulerDelivery>;
}

interface FakeRegistration {
  readonly context: SemanticServiceProviderContext;
  readonly input: RegisterScheduleInput<unknown>;
  readonly inspection: ScheduleLeaseInspection;
  readonly owned: SemanticOwnedLease;
  active: boolean;
}

interface FakeDeliverySubscription {
  readonly context: SemanticServiceProviderContext;
  readonly listener: (
    event: SemanticEventRecord<ScheduledDeliveryEvent>,
  ) => void | Promise<void>;
  readonly owned: SemanticOwnedLease;
  active: boolean;
  sequence: number;
  queue: Promise<void>;
}

class FakeSchedulerFailure extends Error {
  readonly code: SchedulerServiceErrorCode;

  constructor(code: SchedulerServiceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

const CANCELLED = {
  code: SCHEDULER_SERVICE_ERROR_CODES.cancelled,
  message: "Schedule request was cancelled",
  retryable: false,
} as const;

const DISPOSED = {
  code: SCHEDULER_SERVICE_ERROR_CODES.activationDisposed,
  message: "The module activation is no longer active",
  retryable: false,
} as const;

function failedError(error: unknown): SemanticServiceError<SchedulerServiceErrorCode> {
  if (error instanceof FakeSchedulerFailure) {
    return { code: error.code, message: error.message, retryable: false };
  }
  return {
    code: SCHEDULER_SERVICE_ERROR_CODES.transportFailed,
    message: "The fake scheduler request failed",
    retryable: false,
  };
}

function scopedId(value: string): boolean {
  return /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(value);
}

function validateRegistration(input: RegisterScheduleInput<unknown>): void {
  if (!scopedId(input.scheduleId) || !scopedId(input.target.endpoint.id)) {
    throw new FakeSchedulerFailure(
      SCHEDULER_SERVICE_ERROR_CODES.invalidRequest,
      "Schedule identity is invalid",
    );
  }
  const message = input.target.endpoint.message;
  if (!scopedId(message.id) || !Number.isSafeInteger(message.version) || message.version < 1) {
    throw new FakeSchedulerFailure(
      SCHEDULER_SERVICE_ERROR_CODES.invalidRequest,
      "Scheduled message identity is invalid",
    );
  }
  const segments = input.cron.trim().split(/\s+/);
  if (segments.length !== 6 || !segments[5].includes("/")) {
    throw new FakeSchedulerFailure(
      SCHEDULER_SERVICE_ERROR_CODES.invalidRequest,
      "Schedule cron requires five fields and an explicit IANA timezone",
    );
  }
}

function digest(input: RegisterScheduleInput<unknown>): string {
  const encoded = JSON.stringify(input);
  let state = 0x811c9dc5;
  for (let index = 0; index < encoded.length; index += 1) {
    state ^= encoded.charCodeAt(index);
    state = Math.imul(state, 0x01000193);
  }
  return Math.abs(state >>> 0).toString(16).padStart(8, "0").repeat(8);
}

/** Deterministic wall clock. Tests provide exact future occurrences per schedule. */
export class FakeSchedulerClock {
  readonly #occurrences = new Map<string, number[]>();
  readonly #registrations = new Set<{
    readonly scheduleId: string;
    readonly fire: (occurrenceUnixMs: number) => Promise<void>;
  }>();
  #nowUnixMs: number;

  constructor(nowUnixMs = 0) {
    this.#nowUnixMs = nowUnixMs;
  }

  get nowUnixMs(): number {
    return this.#nowUnixMs;
  }

  setOccurrences(scheduleId: string, occurrencesUnixMs: readonly number[]): void {
    if (occurrencesUnixMs.some((value) => !Number.isSafeInteger(value) || value < this.#nowUnixMs)) {
      throw new Error("Fake schedule occurrences must be future integer timestamps");
    }
    this.#occurrences.set(scheduleId, [...occurrencesUnixMs].sort((left, right) => left - right));
  }

  register(
    scheduleId: string,
    fire: (occurrenceUnixMs: number) => Promise<void>,
  ): () => void {
    const registration = { scheduleId, fire };
    this.#registrations.add(registration);
    return () => { this.#registrations.delete(registration); };
  }

  async advanceTo(unixMs: number): Promise<void> {
    if (!Number.isSafeInteger(unixMs) || unixMs < this.#nowUnixMs) {
      throw new Error("Fake scheduler clock cannot move backwards");
    }
    const due = [...this.#registrations].flatMap((registration) =>
      (this.#occurrences.get(registration.scheduleId) ?? [])
        .filter((occurrence) => occurrence > this.#nowUnixMs && occurrence <= unixMs)
        .map((occurrence) => ({ occurrence, registration })))
      .sort((left, right) => left.occurrence - right.occurrence
        || left.registration.scheduleId.localeCompare(right.registration.scheduleId));
    for (const item of due) await item.registration.fire(item.occurrence);
    this.#nowUnixMs = unixMs;
  }
}

class FakeSchedulerHost {
  readonly #clock: FakeSchedulerClock;
  readonly #deliver: NonNullable<FakeSchedulerProviderOptions["deliver"]>;
  readonly #registrations = new Map<string, FakeRegistration>();
  readonly #bySchedule = new Map<string, string>();
  readonly #subscriptions = new Set<FakeDeliverySubscription>();
  #nextLease = 1;

  constructor(options: FakeSchedulerProviderOptions) {
    this.#clock = options.clock ?? new FakeSchedulerClock();
    this.#deliver = options.deliver ?? (() => ({ outcome: "delivered", routeGeneration: 1 }));
  }

  register(
    context: SemanticServiceProviderContext,
    input: RegisterScheduleInput<unknown>,
  ): ScheduleLease {
    validateRegistration(input);
    if (this.#bySchedule.has(input.scheduleId)) {
      throw new FakeSchedulerFailure(
        SCHEDULER_SERVICE_ERROR_CODES.conflict,
        "Schedule identity is already registered",
      );
    }
    const leaseId = `schedule-lease#${this.#nextLease}`;
    this.#nextLease += 1;
    const inspection: ScheduleLeaseInspection = {
      schemaVersion: SCHEDULER_SERVICE_SCHEMA_VERSION,
      leaseId,
      ownerModuleId: context.activation.moduleId,
      ownerActivationId: context.activation.activationId,
      scheduleId: input.scheduleId,
      definitionDigestSha256: digest(input),
      registeredAtUnixMs: this.#clock.nowUnixMs,
    };
    let unregisterClock = () => {};
    let registration: FakeRegistration;
    const owned = context.own(() => {
      if (!registration.active) return;
      registration.active = false;
      unregisterClock();
      this.#registrations.delete(leaseId);
      this.#bySchedule.delete(input.scheduleId);
    });
    registration = { context, input, inspection, owned, active: true };
    unregisterClock = this.#clock.register(input.scheduleId, async (occurrenceUnixMs) => {
      if (!registration.active || !context.active) return;
      const delivery = await this.#deliver(input, new Date(occurrenceUnixMs).toISOString());
      await this.#publish(registration, {
        scheduleId: input.scheduleId,
        occurrenceUtc: new Date(occurrenceUnixMs).toISOString(),
        outcome: delivery.outcome,
        routeGeneration: delivery.routeGeneration,
      });
    });
    this.#registrations.set(leaseId, registration);
    this.#bySchedule.set(input.scheduleId, leaseId);
    return Object.freeze({
      get id() { return owned.id; },
      get activation() { return owned.activation; },
      get disposed() { return owned.disposed; },
      scheduleId: input.scheduleId,
      inspection,
      dispose: () => owned.dispose(),
    });
  }

  inspect(context: SemanticServiceProviderContext): readonly ScheduleLeaseInspection[] {
    return [...this.#registrations.values()]
      .filter((registration) => registration.active
        && registration.context.activation.activationId === context.activation.activationId)
      .map(({ inspection }) => inspection)
      .sort((left, right) => left.scheduleId.localeCompare(right.scheduleId));
  }

  subscribe(
    context: SemanticServiceProviderContext,
    listener: FakeDeliverySubscription["listener"],
  ): SemanticEventLease {
    let subscription: FakeDeliverySubscription;
    const owned = context.own(async () => {
      subscription.active = false;
      this.#subscriptions.delete(subscription);
      await subscription.queue;
    });
    subscription = {
      context,
      listener,
      owned,
      active: true,
      sequence: 0,
      queue: Promise.resolve(),
    };
    this.#subscriptions.add(subscription);
    return Object.freeze({
      get id() { return owned.id; },
      get activation() { return owned.activation; },
      get disposed() { return owned.disposed; },
      dispose: () => owned.dispose(),
    });
  }

  async #publish(
    registration: FakeRegistration,
    value: ScheduledDeliveryEvent,
  ): Promise<void> {
    const settlements: Promise<void>[] = [];
    for (const subscription of this.#subscriptions) {
      if (!subscription.active
        || !subscription.context.active
        || subscription.context.activation.activationId
          !== registration.context.activation.activationId) continue;
      subscription.sequence += 1;
      const event = {
        sourceId: "shipctl.scheduler.delivery",
        sequence: subscription.sequence,
        value,
      };
      subscription.queue = subscription.queue.then(async () => {
        if (subscription.active && subscription.context.active) {
          await subscription.listener(event);
        }
      });
      settlements.push(subscription.queue);
    }
    await Promise.all(settlements);
  }
}

function requireGrant(options: FakeSchedulerProviderOptions): void {
  if (options.deniedGrants?.includes(SCHEDULER_REGISTER_GRANT)) {
    throw new FakeSchedulerFailure(
      SCHEDULER_SERVICE_ERROR_CODES.denied,
      "Schedule registration grant was denied",
    );
  }
}

function operation<Input, Output>(
  context: SemanticServiceProviderContext,
  name: FakeSchedulerOperation,
  options: FakeSchedulerProviderOptions,
  handle: (input: Input) => Output | Promise<Output>,
) {
  const traces: FakeRequestTrace<Input>[] = [];
  const request = createFakeRequestOperation({
    context,
    policy: POLICY,
    handle: ({ input }) => handle(input),
    failedError,
    cancelledError: CANCELLED,
    disposedError: DISPOSED,
    trace: traces,
  });
  const execute = request.execute.bind(request);
  return Object.freeze({
    policy: request.policy,
    async execute(input: Input, requestOptions?: Parameters<typeof execute>[1]) {
      const traceCount = traces.length;
      const outcome = await execute(input, requestOptions);
      const captured = traces[traceCount];
      if (captured) {
        options.trace?.push({
          operation: name,
          request: captured as FakeRequestTrace<
            RegisterScheduleInput<unknown> | InspectSchedulesInput
          >,
        });
      }
      return outcome;
    },
  });
}

/** Tauri-free scheduler with an explicit deterministic wall clock. */
export function createFakeSchedulerServiceProvider(
  options: FakeSchedulerProviderOptions = {},
): SemanticServiceProvider<SchedulerService> {
  const host = new FakeSchedulerHost(options);
  return {
    service: schedulerService,
    bind(context) {
      const register = operation<RegisterScheduleInput<unknown>, ScheduleLease>(
        context,
        "register",
        options,
        (input) => {
          requireGrant(options);
          return host.register(context, input);
        },
      );
      return Object.freeze({
        registerSchedule: Object.freeze({
          policy: register.policy,
          execute<Payload>(
            input: RegisterScheduleInput<Payload>,
            requestOptions?: Parameters<typeof register.execute>[1],
          ) {
            return register.execute(
              input as RegisterScheduleInput<unknown>,
              requestOptions,
            );
          },
        }),
        inspectSchedules: operation<InspectSchedulesInput, readonly ScheduleLeaseInspection[]>(
          context,
          "inspect",
          options,
          (input) => {
            requireGrant(options);
            if (input.owner !== "activation") {
              throw new FakeSchedulerFailure(
                SCHEDULER_SERVICE_ERROR_CODES.invalidRequest,
                "Schedule inspection scope is invalid",
              );
            }
            return host.inspect(context);
          },
        ),
        observeDelivery: Object.freeze({
          async subscribe(
            scope: InspectSchedulesInput,
            listener: FakeDeliverySubscription["listener"],
          ) {
            requireGrant(options);
            if (!context.active) throw new Error(DISPOSED.message);
            if (scope.owner !== "activation") {
              throw new Error("Schedule observation scope is invalid");
            }
            return host.subscribe(context, listener);
          },
        }),
      });
    },
  };
}
