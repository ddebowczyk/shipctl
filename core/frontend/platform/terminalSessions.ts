import {
  TERMINAL_SESSION_GRANTS,
  TERMINAL_SESSIONS_ERROR_CODES,
  terminalSessionsService,
  type AttachTerminalBytesInput,
  type FocusTerminalSessionInput,
  type InspectTerminalSessionsInput,
  type ModuleId,
  type ModuleTerminalDimensions,
  type ModuleTerminalSession,
  type SemanticCorrelationId,
  type SemanticEventRecord,
  type SemanticOwnedLease,
  type SemanticRequestOperation,
  type SemanticResult,
  type SemanticServiceError,
  type SemanticServiceProvider,
  type SemanticStreamAttachment,
  type SemanticStreamAttachmentId,
  type SemanticStreamDelivery,
  type TerminalByteFrame,
  type TerminalHostPort,
  type TerminalSessionGrant,
  type TerminalSessionLifecycleScope,
  type TerminalSessionsErrorCode,
  type TerminalSessionsService,
  type ResizeTerminalInput,
  type StartTerminalSessionInput,
  type StopTerminalSessionInput,
  type UpdateTerminalSessionInput,
  type WriteTerminalInput,
} from "@shipctl/module-api";
import type { ActivationTerminalSessionsRuntime } from "@shipctl/core/terminal-host";

import {
  createSemanticRequestAdapter,
  type PrivateSemanticRequestEnvelope,
} from "./semanticServiceAdapter.ts";

export interface TerminalSessionsTransportBinding {
  readonly moduleId: ModuleId;
  readonly activationId: string;
  readonly grants: ReadonlySet<string>;
}

export interface TerminalSessionsServiceProviderOptions {
  readonly bindingsByActivation: ReadonlyMap<string, TerminalSessionsTransportBinding>;
  readonly runtime: ActivationTerminalSessionsRuntime;
  readonly terminalHost: TerminalHostPort;
  readonly correlationId?: () => SemanticCorrelationId;
  readonly observeRequest?: (
    operation: string,
    request: PrivateSemanticRequestEnvelope<unknown>,
  ) => void;
}

const POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

function failure(
  code: TerminalSessionsErrorCode,
  message: string,
): SemanticServiceError<TerminalSessionsErrorCode> {
  return { code, message, retryable: false };
}

const CANCELLED = failure(
  TERMINAL_SESSIONS_ERROR_CODES.cancelled,
  "Terminal session request was cancelled",
);
const DISPOSED = failure(
  TERMINAL_SESSIONS_ERROR_CODES.activationDisposed,
  "The module activation is no longer active",
);

function correlationId(): SemanticCorrelationId {
  return crypto.randomUUID() as SemanticCorrelationId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class TerminalSessionsFailure extends Error {
  readonly code: TerminalSessionsErrorCode;

  constructor(code: TerminalSessionsErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function transportError(error: unknown): SemanticServiceError<TerminalSessionsErrorCode> {
  if (error instanceof TerminalSessionsFailure) {
    return failure(error.code, error.message);
  }
  const message = errorMessage(error);
  if (/not found|unavailable/i.test(message)) {
    return failure(
      TERMINAL_SESSIONS_ERROR_CODES.notFound,
      "The terminal session is unavailable",
    );
  }
  if (/denied|does not own|not authorized/i.test(message)) {
    return failure(
      TERMINAL_SESSIONS_ERROR_CODES.denied,
      "The terminal session operation was denied",
    );
  }
  return failure(
    TERMINAL_SESSIONS_ERROR_CODES.transportFailed,
    "The terminal session transport failed",
  );
}

function requireGrant(binding: TerminalSessionsTransportBinding, grant: TerminalSessionGrant): void {
  if (!binding.grants.has(grant)) {
    throw new TerminalSessionsFailure(
      TERMINAL_SESSIONS_ERROR_CODES.denied,
      `Terminal grant ${grant} was denied`,
    );
  }
}

function request<Input, Output>(
  operation: string,
  binding: TerminalSessionsTransportBinding,
  active: () => boolean,
  grant: TerminalSessionGrant | null,
  createCorrelationId: () => SemanticCorrelationId,
  observeRequest: TerminalSessionsServiceProviderOptions["observeRequest"],
  execute: (input: Input) => Output | Promise<Output>,
): SemanticRequestOperation<Input, Output, TerminalSessionsErrorCode> {
  return createSemanticRequestAdapter({
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
      async request(envelope): Promise<SemanticResult<Output, TerminalSessionsErrorCode>> {
        observeRequest?.(operation, envelope);
        if (grant) requireGrant(binding, grant);
        return { ok: true, value: await execute(envelope.input) };
      },
    },
  });
}

interface AttachmentOwnership {
  readonly terminalId: string;
  readonly claimsResize: boolean;
}

class TerminalBytesAttachment implements SemanticStreamAttachment {
  readonly id: SemanticStreamAttachmentId;
  readonly activation;
  readonly #raw;
  readonly #listener;
  readonly #remove: () => void;
  readonly #pending: Array<{ readonly sequence: number; readonly value: TerminalByteFrame }> = [];
  #owned: SemanticOwnedLease | null = null;
  #credit: number;
  #acknowledgedSequence: number | null = null;
  #lastDeliveredSequence: number | null = null;
  #lastObservedSequence: number;
  #queue: Promise<void> = Promise.resolve();
  #disposed = false;
  #sourceEnded = false;

  constructor(
    activation: TerminalSessionsTransportBinding,
    raw: Awaited<ReturnType<TerminalHostPort["attachRaw"]>>,
    initialCredit: number,
    listener: (delivery: SemanticStreamDelivery<TerminalByteFrame>) => void | Promise<void>,
    remove: () => void,
  ) {
    this.id = raw.id as SemanticStreamAttachmentId;
    this.activation = {
      moduleId: activation.moduleId,
      activationId: activation.activationId as never,
    };
    this.#raw = raw;
    this.#listener = listener;
    this.#remove = remove;
    this.#credit = initialCredit;
    this.#lastObservedSequence = raw.sequenceBoundary;
  }

  bindOwned(owned: SemanticOwnedLease): void {
    this.#owned = owned;
  }

  get disposed(): boolean {
    return this.#disposed || this.#owned?.disposed === true;
  }

  get acknowledgedSequence(): number | null {
    return this.#acknowledgedSequence;
  }

  async reportGap(requestedAfterSequence: number): Promise<void> {
    await this.#deliver({
      type: "gap",
      attachmentId: this.id,
      requestedAfterSequence,
      earliestAvailableSequence: this.#raw.sequenceBoundary + 1,
    });
  }

  start(): void {
    void this.#consume();
  }

  grant(credit: number): void {
    if (!Number.isSafeInteger(credit) || credit < 1) {
      throw new Error("Terminal stream credit must be a positive safe integer");
    }
    if (this.disposed || this.#sourceEnded) return;
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
      throw new Error("Terminal stream acknowledgement is outside the delivered sequence");
    }
    this.#acknowledgedSequence = sequence;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#pending.length = 0;
    this.#remove();
    await this.#raw.detach();
    await this.#queue;
  }

  async #consume(): Promise<void> {
    try {
      for await (const occurrence of this.#raw.occurrences) {
        if (this.disposed) return;
        if (occurrence.sequence <= this.#lastObservedSequence) {
          await this.#disconnect("terminal-stream-order-violation", false);
          return;
        }
        this.#lastObservedSequence = occurrence.sequence;
        this.#pending.push({
          sequence: occurrence.sequence,
          value: { bytes: occurrence.bytes },
        });
        this.#drain();
      }
      if (!this.disposed) await this.#disconnect("terminal-stream-closed", false);
    } catch {
      if (!this.disposed) await this.#disconnect("terminal-stream-failed", false);
    }
  }

  #drain(): void {
    while (!this.disposed && this.#credit > 0 && this.#pending.length > 0) {
      const next = this.#pending.shift();
      if (!next) return;
      this.#credit -= 1;
      this.#lastDeliveredSequence = next.sequence;
      void this.#deliver({
        type: "frame",
        attachmentId: this.id,
        sequence: next.sequence,
        value: next.value,
      });
    }
  }

  #deliver(delivery: SemanticStreamDelivery<TerminalByteFrame>): Promise<void> {
    const deliveryPromise = this.#queue.then(async () => {
      if (!this.disposed) await this.#listener(delivery);
    });
    this.#queue = deliveryPromise.catch(() => undefined);
    return this.#queue;
  }

  async #disconnect(reason: string, resumable: boolean): Promise<void> {
    if (this.disposed || this.#sourceEnded) return;
    this.#sourceEnded = true;
    await this.#deliver({
      type: "disconnected",
      attachmentId: this.id,
      reason,
      resumable,
    });
    await this.#owned?.dispose();
  }
}

/** Trusted activation adapter over the current terminal host and UI runtime. */
export function createTerminalSessionsServiceProvider(
  options: TerminalSessionsServiceProviderOptions,
): SemanticServiceProvider<TerminalSessionsService> {
  const createCorrelationId = options.correlationId ?? correlationId;
  return {
    service: terminalSessionsService,
    bind(context) {
      const binding = options.bindingsByActivation.get(context.activation.activationId);
      if (
        !binding
        || binding.moduleId !== context.activation.moduleId
        || binding.activationId !== context.activation.activationId
      ) {
        throw new Error("The module activation has no admitted terminal-session binding");
      }
      const attachments = new Map<string, AttachmentOwnership>();
      let inputQueue = Promise.resolve();
      const active = () => context.active;

      const service: TerminalSessionsService = Object.freeze({
        dimensions: request<Readonly<Record<never, never>>, ModuleTerminalDimensions>(
          "dimensions", binding, active, null, createCorrelationId,
          options.observeRequest, () => options.runtime.getDimensions()),
        inspectSessions: request<InspectTerminalSessionsInput, readonly ModuleTerminalSession[]>(
          "inspect", binding, active, TERMINAL_SESSION_GRANTS.attach,
          createCorrelationId, options.observeRequest, (input) => {
            if (input.owner !== "activation") {
              throw new TerminalSessionsFailure(
                TERMINAL_SESSIONS_ERROR_CODES.invalidRequest,
                "Terminal inspection scope is invalid",
              );
            }
            return options.runtime.list(binding.moduleId);
          }),
        startSession: request<StartTerminalSessionInput, ModuleTerminalSession>(
          "start", binding, active, TERMINAL_SESSION_GRANTS.start,
          createCorrelationId, options.observeRequest,
          (input) => options.runtime.launch(binding.moduleId, input)),
        updateSession: request<UpdateTerminalSessionInput, ModuleTerminalSession>(
          "update", binding, active, TERMINAL_SESSION_GRANTS.start,
          createCorrelationId, options.observeRequest,
          (input) => options.runtime.update(binding.moduleId, input.sessionId, input.patch)),
        focusSession: request<FocusTerminalSessionInput, ModuleTerminalSession>(
          "focus", binding, active, TERMINAL_SESSION_GRANTS.attach,
          createCorrelationId, options.observeRequest,
          (input) => options.runtime.focus(binding.moduleId, input.sessionId)),
        stopSession: request<StopTerminalSessionInput, ModuleTerminalSession>(
          "stop", binding, active, TERMINAL_SESSION_GRANTS.stop,
          createCorrelationId, options.observeRequest,
          (input) => options.runtime.stop(binding.moduleId, input.sessionId)),
        writeInput: request<WriteTerminalInput, Readonly<Record<never, never>>>(
          "input", binding, active, TERMINAL_SESSION_GRANTS.input,
          createCorrelationId, options.observeRequest, async (input) => {
            const owner = attachments.get(input.attachmentId);
            if (!owner || owner.terminalId !== input.terminalId) {
              throw new TerminalSessionsFailure(
                TERMINAL_SESSIONS_ERROR_CODES.denied,
                "The activation does not own the terminal input attachment",
              );
            }
            const write = inputQueue.then(() =>
              options.terminalHost.write(input.terminalId, input.bytes));
            inputQueue = write.catch(() => undefined);
            await write;
            return {};
          }),
        resize: request<ResizeTerminalInput, Readonly<Record<never, never>>>(
          "resize", binding, active, TERMINAL_SESSION_GRANTS.resize,
          createCorrelationId, options.observeRequest, async (input) => {
            const owner = attachments.get(input.attachmentId);
            if (!owner || owner.terminalId !== input.terminalId || !owner.claimsResize) {
              throw new TerminalSessionsFailure(
                TERMINAL_SESSIONS_ERROR_CODES.denied,
                "The activation does not own resize authority for this terminal",
              );
            }
            if (
              !Number.isSafeInteger(input.columns)
              || input.columns < 1
              || input.columns > 65_535
              || !Number.isSafeInteger(input.rows)
              || input.rows < 1
              || input.rows > 65_535
            ) {
              throw new TerminalSessionsFailure(
                TERMINAL_SESSIONS_ERROR_CODES.invalidRequest,
                "Terminal dimensions must be integers from 1 through 65535",
              );
            }
            await options.terminalHost.resize(
              input.terminalId,
              input.attachmentId,
              input.columns,
              input.rows,
            );
            return {};
        }),
        lifecycle: Object.freeze({
          async subscribe(
            scope: TerminalSessionLifecycleScope,
            listener: Parameters<TerminalSessionsService["lifecycle"]["subscribe"]>[1],
          ) {
            requireGrant(binding, TERMINAL_SESSION_GRANTS.attach);
            if (!context.active) throw new Error(DISPOSED.message);
            if (scope.owner !== "activation") {
              throw new TerminalSessionsFailure(
                TERMINAL_SESSIONS_ERROR_CODES.invalidRequest,
                "Terminal lifecycle scope is invalid",
              );
            }
            let sequence = 0;
            let active = true;
            let deliveryQueue = Promise.resolve();
            const unsubscribe = options.runtime.subscribe(binding.moduleId, async (event) => {
              if (!active || !context.active) return;
              sequence += 1;
              const record: SemanticEventRecord<typeof event> = {
                sourceId: "shipctl.terminal-sessions.lifecycle",
                sequence,
                value: event,
              };
              const delivery = deliveryQueue.then(() => listener(record));
              deliveryQueue = delivery.catch(() => undefined);
              await delivery;
            });
            const owned = context.own(async () => {
              active = false;
              unsubscribe();
              await deliveryQueue;
            });
            return Object.freeze({
              get id() { return owned.id; },
              get activation() { return owned.activation; },
              get disposed() { return owned.disposed; },
              dispose: () => owned.dispose(),
            });
          },
        }),
        bytes: Object.freeze({
          async attach(
            request: AttachTerminalBytesInput,
            listener: Parameters<TerminalSessionsService["bytes"]["attach"]>[1],
          ) {
            requireGrant(binding, TERMINAL_SESSION_GRANTS.attach);
            if (!context.active) throw new Error(DISPOSED.message);
            if (!Number.isSafeInteger(request.initialCredit) || request.initialCredit < 0) {
              throw new Error("Initial terminal stream credit must be a non-negative safe integer");
            }
            if (
              request.afterSequence !== null
              && (!Number.isSafeInteger(request.afterSequence) || request.afterSequence < 0)
            ) {
              throw new Error("Terminal replay sequence must be a non-negative safe integer or null");
            }
            const raw = await options.terminalHost.attachRaw(
              request.terminalId,
              request.driverId,
              request.claimsResize,
            );
            if (
              request.afterSequence !== null
              && request.afterSequence > raw.sequenceBoundary
            ) {
              await raw.detach();
              throw new Error("Terminal replay sequence is ahead of the live boundary");
            }
            let attachment: TerminalBytesAttachment;
            attachment = new TerminalBytesAttachment(
              binding,
              raw,
              request.initialCredit,
              listener,
              () => { attachments.delete(attachment.id); },
            );
            attachments.set(attachment.id, {
              terminalId: request.terminalId,
              claimsResize: request.claimsResize,
            });
            const owned = context.own(() => attachment.dispose());
            attachment.bindOwned(owned);
            if (
              request.afterSequence !== null
              && request.afterSequence < raw.sequenceBoundary
            ) {
              await attachment.reportGap(request.afterSequence);
            }
            attachment.start();
            return attachment;
          },
        }),
      });
      return service;
    },
  };
}
