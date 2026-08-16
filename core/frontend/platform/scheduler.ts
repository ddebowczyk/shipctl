import { Channel, invoke } from "@tauri-apps/api/core";
import {
  SCHEDULE_DIAGNOSTIC_CODES,
  SCHEDULER_SERVICE_ERROR_CODES,
  SCHEDULER_SERVICE_SCHEMA_VERSION,
  schedulerService,
  type InspectSchedulesInput,
  type ModuleId,
  type RegisterScheduleInput,
  type ScheduledDeliveryEvent,
  type ScheduleLease,
  type ScheduleLeaseInspection,
  type SchedulerService,
  type SchedulerServiceErrorCode,
  type SemanticCorrelationId,
  type SemanticEventRecord,
  type SemanticRequestOptions,
  type SemanticRequestOutcome,
  type SemanticResult,
  type SemanticServiceError,
  type SemanticServiceProvider,
} from "@shipctl/module-api";

import {
  createSemanticRequestAdapter,
  type PrivateSemanticRequestEnvelope,
} from "./semanticServiceAdapter.ts";

const REGISTER_COMMAND = "register_semantic_schedule";
const INSPECT_COMMAND = "inspect_semantic_schedules";
const CANCEL_COMMAND = "cancel_semantic_schedule";
const OBSERVE_COMMAND = "observe_semantic_schedule_deliveries";
const STOP_OBSERVER_COMMAND = "stop_semantic_schedule_observer";

export interface SchedulerTransportBinding {
  readonly moduleId: ModuleId;
  readonly activationId: string;
  readonly bridgeId: string;
}

interface PrivateSchedulerRequest<Input> extends PrivateSemanticRequestEnvelope<Input> {
  readonly bridgeId: string;
}

export interface SchedulerDeliveryFrame {
  readonly sequence: number;
  readonly event: ScheduledDeliveryEvent;
}

export interface SchedulerTransport {
  register(
    request: PrivateSchedulerRequest<RegisterScheduleInput<unknown>>,
  ): Promise<ScheduleLeaseInspection>;
  inspect(
    request: PrivateSchedulerRequest<InspectSchedulesInput>,
  ): Promise<readonly ScheduleLeaseInspection[]>;
  cancel(
    request: PrivateSchedulerRequest<{ readonly leaseId: string }>,
  ): Promise<boolean>;
  observe(
    request: PrivateSchedulerRequest<InspectSchedulesInput>,
    onDelivery: (frame: SchedulerDeliveryFrame) => void,
  ): Promise<string>;
  stopObserver(
    request: PrivateSchedulerRequest<{ readonly observerId: string }>,
  ): Promise<boolean>;
}

type InvokeCommand = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface DeliveryChannel {
  onmessage: ((frame: SchedulerDeliveryFrame) => void) | null;
}

export function createSchedulerTransport(
  invokeCommand: InvokeCommand = invoke,
  createChannel: () => DeliveryChannel = () => new Channel<SchedulerDeliveryFrame>(),
): SchedulerTransport {
  return {
    register: (request) => invokeCommand(REGISTER_COMMAND, { request }),
    inspect: (request) => invokeCommand(INSPECT_COMMAND, { request }),
    cancel: (request) => invokeCommand(CANCEL_COMMAND, { request }),
    observe(request, onDelivery) {
      const channel = createChannel();
      channel.onmessage = onDelivery;
      return invokeCommand(OBSERVE_COMMAND, { request, onDelivery: channel });
    },
    stopObserver: (request) => invokeCommand(STOP_OBSERVER_COMMAND, { request }),
  };
}

export interface SchedulerServiceProviderOptions {
  readonly bindingsByActivation: ReadonlyMap<string, SchedulerTransportBinding>;
  readonly transport?: SchedulerTransport;
  readonly correlationId?: () => SemanticCorrelationId;
}

const POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

const CANCELLED = failure(
  SCHEDULER_SERVICE_ERROR_CODES.cancelled,
  "Schedule request was cancelled",
);
const DISPOSED = failure(
  SCHEDULER_SERVICE_ERROR_CODES.activationDisposed,
  "The module activation is no longer active",
);

function failure(
  code: SchedulerServiceErrorCode,
  message: string,
): SemanticServiceError<SchedulerServiceErrorCode> {
  return { code, message, retryable: false };
}

function correlationId(): SemanticCorrelationId {
  return crypto.randomUUID() as SemanticCorrelationId;
}

function wire<Input>(
  binding: SchedulerTransportBinding,
  id: SemanticCorrelationId,
  input: Input,
): PrivateSchedulerRequest<Input> {
  return {
    bridgeId: binding.bridgeId,
    activation: {
      moduleId: binding.moduleId,
      activationId: binding.activationId as never,
    },
    correlationId: id,
    input,
  };
}

function transportError(error: unknown): SemanticServiceError<SchedulerServiceErrorCode> {
  const value = error as { code?: unknown; message?: unknown } | null;
  const acceptedCodes = new Set<string>([
    ...Object.values(SCHEDULER_SERVICE_ERROR_CODES),
    ...Object.values(SCHEDULE_DIAGNOSTIC_CODES),
  ]);
  const acceptedCode = typeof value?.code === "string" && acceptedCodes.has(value.code);
  const code = acceptedCode
    ? value.code as SchedulerServiceErrorCode
    : /unknown command|not found/i.test(String(error))
      ? SCHEDULER_SERVICE_ERROR_CODES.unavailable
      : SCHEDULER_SERVICE_ERROR_CODES.transportFailed;
  const message = code === SCHEDULER_SERVICE_ERROR_CODES.unavailable
    ? "The scheduler service is unavailable"
    : acceptedCode && typeof value?.message === "string"
      ? value.message
      : "The scheduler transport failed";
  return failure(code, message);
}

function validInspection(
  value: unknown,
  binding: SchedulerTransportBinding,
): value is ScheduleLeaseInspection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const inspection = value as Partial<ScheduleLeaseInspection>;
  return inspection.schemaVersion === SCHEDULER_SERVICE_SCHEMA_VERSION
    && inspection.ownerModuleId === binding.moduleId
    && inspection.ownerActivationId === binding.activationId
    && typeof inspection.leaseId === "string"
    && inspection.leaseId.length > 0
    && typeof inspection.scheduleId === "string"
    && inspection.scheduleId.length > 0
    && typeof inspection.definitionDigestSha256 === "string"
    && /^[0-9a-f]{64}$/.test(inspection.definitionDigestSha256)
    && Number.isSafeInteger(inspection.registeredAtUnixMs)
    && (inspection.registeredAtUnixMs ?? -1) >= 0;
}

function validDeliveryFrame(value: unknown, lastSequence: number): value is SchedulerDeliveryFrame {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const frame = value as Partial<SchedulerDeliveryFrame>;
  if (!Number.isSafeInteger(frame.sequence) || (frame.sequence ?? 0) <= lastSequence) return false;
  const event = frame.event as Partial<ScheduledDeliveryEvent> | undefined;
  return typeof event === "object"
    && event !== null
    && typeof event.scheduleId === "string"
    && event.scheduleId.length > 0
    && typeof event.occurrenceUtc === "string"
    && !Number.isNaN(Date.parse(event.occurrenceUtc))
    && (event.outcome === "delivered" || event.outcome === "failed")
    && Number.isSafeInteger(event.routeGeneration)
    && (event.routeGeneration ?? -1) >= 0;
}

function invalidResponse<Value>(): SemanticResult<Value, SchedulerServiceErrorCode> {
  return {
    ok: false,
    error: failure(
      SCHEDULER_SERVICE_ERROR_CODES.invalidResponse,
      "The scheduler service returned an invalid response",
    ),
  };
}

function request<Input, Output>(
  binding: SchedulerTransportBinding,
  active: () => boolean,
  createCorrelationId: () => SemanticCorrelationId,
  execute: (
    request: PrivateSchedulerRequest<Input>,
  ) => Promise<SemanticResult<Output, SchedulerServiceErrorCode>>,
) {
  return createSemanticRequestAdapter<Input, Output, SchedulerServiceErrorCode>({
      activation: {
        moduleId: binding.moduleId,
        activationId: binding.activationId as never,
    },
    active,
    policy: POLICY,
    correlationId: createCorrelationId,
    cancelledError: CANCELLED,
    disposedError: DISPOSED,
    transportError,
    transport: {
      request(envelope) {
        return execute(wire(binding, envelope.correlationId, envelope.input));
      },
    },
  });
}

/** Binds the native scheduler to one admitted module activation. */
export function createSchedulerServiceProvider(
  options: SchedulerServiceProviderOptions,
): SemanticServiceProvider<SchedulerService> {
  const transport = options.transport ?? createSchedulerTransport();
  const createCorrelationId = options.correlationId ?? correlationId;
  return {
    service: schedulerService,
    bind(context) {
      const binding = options.bindingsByActivation.get(context.activation.activationId);
      if (
        binding === undefined
        || binding.activationId !== context.activation.activationId
        || binding.moduleId !== context.activation.moduleId
      ) {
        throw new Error("The module activation has no admitted scheduler binding");
      }

      const register = request<RegisterScheduleInput<unknown>, ScheduleLease>(
        binding,
        () => context.active,
        createCorrelationId,
        async (request) => {
          const inspection = await transport.register(request);
          if (!validInspection(inspection, binding)
            || inspection.scheduleId !== request.input.scheduleId) {
            return invalidResponse();
          }
          const owned = context.own(async () => {
            await transport.cancel(wire(binding, createCorrelationId(), {
              leaseId: inspection.leaseId,
            }));
          });
          return {
            ok: true,
            value: Object.freeze({
              get id() { return owned.id; },
              get activation() { return owned.activation; },
              get disposed() { return owned.disposed; },
              scheduleId: inspection.scheduleId,
              inspection,
              dispose: () => owned.dispose(),
            }),
          };
        },
      );
      const inspect = request<InspectSchedulesInput, readonly ScheduleLeaseInspection[]>(
        binding,
        () => context.active,
        createCorrelationId,
        async (request) => {
          const inspections = await transport.inspect(request);
          return inspections.every((inspection) => validInspection(inspection, binding))
            ? { ok: true, value: inspections }
            : invalidResponse();
        },
      );

      return Object.freeze({
        registerSchedule: Object.freeze({
          policy: register.policy,
          execute<Payload>(
            input: RegisterScheduleInput<Payload>,
            requestOptions?: SemanticRequestOptions,
          ): Promise<SemanticRequestOutcome<ScheduleLease, SchedulerServiceErrorCode>> {
            return register.execute(
              input as RegisterScheduleInput<unknown>,
              requestOptions,
            );
          },
        }),
        inspectSchedules: inspect,
        observeDelivery: Object.freeze({
          async subscribe(
            scope: InspectSchedulesInput,
            listener: (
              event: SemanticEventRecord<ScheduledDeliveryEvent>,
            ) => void | Promise<void>,
          ) {
            if (!context.active) throw new Error(DISPOSED.message);
            let active = true;
            let lastSequence = 0;
            let queue = Promise.resolve();
            const observerId = await transport.observe(
              wire(binding, createCorrelationId(), scope),
              (frame) => {
                if (!active || !context.active || !validDeliveryFrame(frame, lastSequence)) return;
                lastSequence = frame.sequence;
                queue = queue.then(async () => {
                  if (active && context.active) {
                    await listener({
                      sourceId: "shipctl.scheduler.delivery",
                      sequence: frame.sequence,
                      value: frame.event,
                    });
                  }
                });
              },
            );
            const owned = context.own(async () => {
              active = false;
              await transport.stopObserver(wire(binding, createCorrelationId(), { observerId }));
              await queue;
            });
            return Object.freeze({
              get id() { return owned.id; },
              get activation() { return owned.activation; },
              get disposed() { return owned.disposed; },
              dispose: () => owned.dispose(),
            });
          },
        }),
      });
    },
  };
}
