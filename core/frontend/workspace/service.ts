import {
  type InspectWorkspaceInput,
  type MutateWorkspaceInput,
  type SemanticCorrelationId,
  type SemanticEventLease,
  type SemanticEventRecord,
  type SemanticEventSource,
  type SemanticLeaseId,
  type SemanticRequestOperation,
  type SemanticRequestOptions,
  type SemanticRequestOutcome,
  type SemanticServiceError,
  type SemanticServiceProvider,
  type SemanticServiceProviderContext,
  type WorkspaceErrorCode,
  type WorkspaceInspection,
  type WorkspaceMutationResult,
  type WorkspaceObservation,
  type WorkspaceObservationScope,
  type WorkspaceService,
  workspaceService,
} from "@shipctl/module-api";

import { WorkspaceAuthority, WorkspaceAuthorityError, parseWorkspaceCommand } from "./authority.ts";
import { hasIdentity, isPlainRecord } from "./internal.ts";

const POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

let nextRequest = 1;
let nextLease = 1;

function requestId(): SemanticCorrelationId {
  const id = `workspace-request#${nextRequest}`;
  nextRequest += 1;
  return id as SemanticCorrelationId;
}

function leaseId(): SemanticLeaseId {
  const id = `workspace-observation#${nextLease}`;
  nextLease += 1;
  return id as SemanticLeaseId;
}

function error(
  code: WorkspaceErrorCode,
  message: string,
  details?: SemanticServiceError<WorkspaceErrorCode>["details"],
): SemanticServiceError<WorkspaceErrorCode> {
  return { code, message, retryable: false, ...(details === undefined ? {} : { details }) };
}

function fromFailure(cause: unknown): SemanticServiceError<WorkspaceErrorCode> {
  if (cause instanceof WorkspaceAuthorityError) {
    return error(cause.code, cause.message, cause.details);
  }
  return error(
    "workspace.persistence-failed",
    cause instanceof Error ? cause.message : "Workspace operation failed.",
  );
}

function sameWorkspace(scope: WorkspaceObservationScope, workspaceId: string): boolean {
  return scope.workspaceId === workspaceId;
}

class AuthorityEventSource implements SemanticEventSource<WorkspaceObservationScope, WorkspaceObservation> {
  readonly #context: SemanticServiceProviderContext;
  readonly #authority: WorkspaceAuthority;
  #sequence = 0;

  constructor(context: SemanticServiceProviderContext, authority: WorkspaceAuthority) {
    this.#context = context;
    this.#authority = authority;
  }

  async subscribe(
    scope: WorkspaceObservationScope,
    listener: (event: SemanticEventRecord<WorkspaceObservation>) => void | Promise<void>,
  ): Promise<SemanticEventLease> {
    if (!this.#context.active) throw new Error("Cannot observe from a disposed workspace activation.");
    if (!sameWorkspace(scope, this.#authority.workspaceId)) {
      throw new Error("Workspace observation requested another workspace.");
    }
    let disposed = false;
    const unsubscribe = this.#authority.subscribe(async (value) => {
      if (disposed) return;
      this.#sequence += 1;
      await listener({ sourceId: "shipctl.workspace", sequence: this.#sequence, value });
    });
    const owned = this.#context.own(() => {
      disposed = true;
      unsubscribe();
    });
    return {
      id: leaseId(),
      activation: this.#context.activation,
      get disposed() { return disposed || owned.disposed; },
      dispose: () => owned.dispose(),
    };
  }
}

function request<Input, Output>(
  context: SemanticServiceProviderContext,
  handle: (input: Input) => Promise<Output>,
): SemanticRequestOperation<Input, Output, WorkspaceErrorCode> {
  return {
    policy: POLICY,
    async execute(
      input: Input,
      options?: SemanticRequestOptions,
    ): Promise<SemanticRequestOutcome<Output, WorkspaceErrorCode>> {
      const correlationId = requestId();
      if (!context.active) {
        return {
          correlationId,
          result: { ok: false, error: error("workspace.activation-disposed", "Workspace activation is disposed.") },
        };
      }
      if (options?.cancellation?.cancelled) {
        return {
          correlationId,
          result: { ok: false, error: error("workspace.cancelled", "Workspace request was cancelled.") },
        };
      }
      try {
        return { correlationId, result: { ok: true, value: await handle(input) } };
      } catch (cause) {
        return { correlationId, result: { ok: false, error: fromFailure(cause) } };
      }
    },
  };
}

function inspectInput(input: InspectWorkspaceInput, workspaceId: string): InspectWorkspaceInput {
  if (
    !isPlainRecord(input)
    || !hasIdentity(input.workspaceId)
    || typeof input.includeDocument !== "boolean"
  ) {
    throw new WorkspaceAuthorityError("workspace.invalid-request", "Workspace inspection request is invalid.");
  }
  if (input.workspaceId !== workspaceId) {
    throw new WorkspaceAuthorityError("workspace.not-found", "Workspace inspection requested another workspace.");
  }
  return input;
}

function mutationInput(input: MutateWorkspaceInput, workspaceId: string): MutateWorkspaceInput {
  if (!isPlainRecord(input) || !hasIdentity(input.workspaceId)) {
    throw new WorkspaceAuthorityError("workspace.invalid-request", "Workspace mutation request is invalid.");
  }
  if (input.workspaceId !== workspaceId) {
    throw new WorkspaceAuthorityError("workspace.not-found", "Workspace mutation requested another workspace.");
  }
  return { workspaceId: input.workspaceId, command: parseWorkspaceCommand(input.command) };
}

export interface WorkspaceServiceProviderOptions {
  readonly authority: WorkspaceAuthority;
}

/**
 * Trusted host provider for the public Workspace capability. It exposes only
 * semantic operations and observations; catalog reconciliation remains an
 * internal host action fed by accepted runtime catalogs.
 */
export function createWorkspaceServiceProvider(
  options: WorkspaceServiceProviderOptions,
): SemanticServiceProvider<WorkspaceService> {
  return {
    service: workspaceService,
    bind(context) {
      const authority = options.authority;
      return Object.freeze({
        mutateWorkspace: request<MutateWorkspaceInput, WorkspaceMutationResult>(
          context,
          async (input) => authority.mutate(mutationInput(input, authority.workspaceId).command),
        ),
        inspectWorkspace: request<InspectWorkspaceInput, WorkspaceInspection>(
          context,
          async (input) => authority.inspect(inspectInput(input, authority.workspaceId).includeDocument),
        ),
        observeWorkspace: new AuthorityEventSource(context, authority),
      });
    },
  };
}
