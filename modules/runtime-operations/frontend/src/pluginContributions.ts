import {
  configurationService,
  isRuntimeOperation,
  parseRuntimeOperationRequest,
  parseRuntimeOperationResponse,
  runtimeOperationFailure,
  workspaceService,
  type CapabilityPort,
  type MessageTypeContract,
  type ModuleActivationContext,
  type ModuleJsonValue,
  type ModuleMessageContributions,
  type RuntimeOperation,
  type RuntimeOperationRequest,
  type RuntimeOperationResponse,
  type ConfigurationService,
  type SemanticResult,
  type WorkspaceService,
} from "@shipctl/module-api";

export const RUNTIME_OPERATIONS_MODULE_ID = "shipctl.runtime-operations" as const;
export const RUNTIME_OPERATIONS_PLUGIN_VERSION = "0.0.0" as const;

export const RUNTIME_OPERATIONS_REQUIRED_GRANTS = [
  "message.request.shipctl.workspace.execute",
  "message.request.shipctl.configuration.execute",
] as const;

export const RUNTIME_OPERATION_REQUEST_MESSAGE = Object.freeze({
  id: "shipctl.runtime-operation.request",
  version: 1,
} as const);

export const RUNTIME_OPERATION_RESPONSE_MESSAGE = Object.freeze({
  id: "shipctl.runtime-operation.response",
  version: 1,
} as const);

export const WORKSPACE_RUNTIME_OPERATION_PORT: CapabilityPort<unknown, RuntimeOperationResponse> = {
  id: "shipctl.workspace.execute",
  request: RUNTIME_OPERATION_REQUEST_MESSAGE,
  response: RUNTIME_OPERATION_RESPONSE_MESSAGE,
};

export const CONFIGURATION_RUNTIME_OPERATION_PORT: CapabilityPort<unknown, RuntimeOperationResponse> = {
  id: "shipctl.configuration.execute",
  request: RUNTIME_OPERATION_REQUEST_MESSAGE,
  response: RUNTIME_OPERATION_RESPONSE_MESSAGE,
};

const RUNTIME_OPERATION_REQUEST_CONTRACT: MessageTypeContract<unknown> = {
  message: RUNTIME_OPERATION_REQUEST_MESSAGE,
  schema: {
    draft: "https://json-schema.org/draft/2020-12/schema",
    root: "messages/runtime-operation-request.schema.json",
    resources: {
      "messages/runtime-operation-request.schema.json": {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "shipctl-artifact:///messages/runtime-operation-request.schema.json",
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["schemaVersion", "operation", "workspaceId", "includeDocument"],
            properties: {
              schemaVersion: { const: 1 },
              operation: { const: "workspace.inspect" },
              workspaceId: { type: "string", minLength: 1 },
              includeDocument: { type: "boolean" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["schemaVersion", "operation", "workspaceId", "command"],
            properties: {
              schemaVersion: { const: 1 },
              operation: {
                enum: ["workspace.validate", "workspace.plan", "workspace.apply", "workspace.mutate"],
              },
              workspaceId: { type: "string", minLength: 1 },
              command: true,
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["schemaVersion", "operation", "key"],
            properties: {
              schemaVersion: { const: 1 },
              operation: { enum: ["configuration.inspect", "configuration.resolve"] },
              key: { enum: ["runtime", "editor", "projects", "keybindings", "terminal", "sidebar"] },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["schemaVersion", "operation", "key", "value"],
            properties: {
              schemaVersion: { const: 1 },
              operation: { const: "configuration.update" },
              key: { enum: ["runtime", "editor", "projects", "keybindings", "terminal", "sidebar"] },
              value: true,
            },
          },
        ],
      },
    },
    maxEncodedBytes: 1048576,
    redactedFields: [],
    compatibleVersions: [1],
  },
};

const RUNTIME_OPERATION_RESPONSE_CONTRACT: MessageTypeContract<RuntimeOperationResponse> = {
  message: RUNTIME_OPERATION_RESPONSE_MESSAGE,
  schema: {
    draft: "https://json-schema.org/draft/2020-12/schema",
    root: "messages/runtime-operation-response.schema.json",
    resources: {
      "messages/runtime-operation-response.schema.json": {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "shipctl-artifact:///messages/runtime-operation-response.schema.json",
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["schemaVersion", "status", "operation", "value"],
            properties: {
              schemaVersion: { const: 1 },
              status: { const: "ok" },
              operation: {
                enum: [
                  "workspace.inspect",
                  "workspace.validate",
                  "workspace.plan",
                  "workspace.apply",
                  "workspace.mutate",
                  "configuration.inspect",
                  "configuration.resolve",
                  "configuration.update",
                ],
              },
              value: true,
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["schemaVersion", "status", "operation", "code", "message"],
            properties: {
              schemaVersion: { const: 1 },
              status: { const: "error" },
              operation: {
                enum: [
                  "workspace.inspect",
                  "workspace.validate",
                  "workspace.plan",
                  "workspace.apply",
                  "workspace.mutate",
                  "configuration.inspect",
                  "configuration.resolve",
                  "configuration.update",
                ],
              },
              code: { type: "string", minLength: 1 },
              message: { type: "string", minLength: 1 },
              details: true,
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["schemaVersion", "status", "operation", "code", "message"],
            properties: {
              schemaVersion: { const: 1 },
              status: { const: "unavailable" },
              operation: {
                enum: [
                  "workspace.inspect",
                  "workspace.validate",
                  "workspace.plan",
                  "workspace.apply",
                  "workspace.mutate",
                  "configuration.inspect",
                  "configuration.resolve",
                  "configuration.update",
                ],
              },
              code: { const: "runtime.operation.unavailable" },
              message: { type: "string", minLength: 1 },
              details: true,
            },
          },
        ],
      },
    },
    maxEncodedBytes: 1048576,
    redactedFields: [],
    compatibleVersions: [1],
  },
};

/**
 * Creates one activation-owned message graph. The public semantic services
 * retain command parsing, configuration migration, and persistence policy.
 */
export function createRuntimeOperationMessageContributions(
  activation: ModuleActivationContext,
): ModuleMessageContributions {
  const workspace = activation.services.require(workspaceService);
  const configuration = activation.services.require(configurationService);

  return Object.freeze({
    provides: Object.freeze([
      RUNTIME_OPERATION_REQUEST_CONTRACT,
      RUNTIME_OPERATION_RESPONSE_CONTRACT,
    ]),
    ports: Object.freeze([
      {
        port: WORKSPACE_RUNTIME_OPERATION_PORT,
        capacity: 1,
        requiredGrant: "message.request.shipctl.workspace.execute",
        schedulerAllowed: false,
        handle: async (payload) => executeWorkspaceOperation(payload, workspace),
      },
      {
        port: CONFIGURATION_RUNTIME_OPERATION_PORT,
        capacity: 1,
        requiredGrant: "message.request.shipctl.configuration.execute",
        schedulerAllowed: false,
        handle: async (payload) => executeConfigurationOperation(payload, configuration),
      },
    ]),
  } satisfies ModuleMessageContributions);
}

async function executeWorkspaceOperation(
  payload: unknown,
  workspace: WorkspaceService,
): Promise<RuntimeOperationResponse> {
  const request = parseOrFailure(payload);
  if (isRuntimeOperationResponse(request)) return request;
  if (!request.operation.startsWith("workspace.")) {
    return runtimeOperationFailure(
      request.operation,
      "runtime.operation.invalid-request",
      "The workspace capability accepts only workspace operations.",
    );
  }
  switch (request.operation) {
    case "workspace.inspect":
      return responseFromResult(
        request.operation,
        await workspace.inspectWorkspace.execute({
          workspaceId: request.workspaceId,
          includeDocument: request.includeDocument,
        }),
      );
    case "workspace.validate":
      return responseFromResult(
        request.operation,
        await workspace.validateWorkspace.execute({ workspaceId: request.workspaceId, command: request.command }),
      );
    case "workspace.plan":
      return responseFromResult(
        request.operation,
        await workspace.planWorkspace.execute({ workspaceId: request.workspaceId, command: request.command }),
      );
    case "workspace.apply":
      return responseFromResult(
        request.operation,
        await workspace.applyWorkspace.execute({ workspaceId: request.workspaceId, command: request.command }),
      );
    case "workspace.mutate":
      return responseFromResult(
        request.operation,
        await workspace.mutateWorkspace.execute({ workspaceId: request.workspaceId, command: request.command }),
      );
  }
}

async function executeConfigurationOperation(
  payload: unknown,
  configuration: ConfigurationService,
): Promise<RuntimeOperationResponse> {
  const request = parseOrFailure(payload);
  if (isRuntimeOperationResponse(request)) return request;
  if (!request.operation.startsWith("configuration.")) {
    return runtimeOperationFailure(
      request.operation,
      "runtime.operation.invalid-request",
      "The configuration capability accepts only configuration operations.",
    );
  }
  switch (request.operation) {
    case "configuration.inspect":
      return responseFromResult(
        request.operation,
        await configuration.inspectConfiguration.execute({ key: request.key }),
      );
    case "configuration.resolve":
      return responseFromResult(
        request.operation,
        await configuration.resolveConfiguration.execute({ key: request.key }),
      );
    case "configuration.update":
      return responseFromResult(
        request.operation,
        await configuration.updateConfiguration.execute({ key: request.key, value: request.value }),
      );
  }
}

function parseOrFailure(payload: unknown): RuntimeOperationRequest | RuntimeOperationResponse {
  try {
    return parseRuntimeOperationRequest(payload);
  } catch {
    return runtimeOperationFailure(
      operationFromPayload(payload),
      "runtime.operation.invalid-request",
      "Runtime operation request is invalid.",
    );
  }
}

function operationFromPayload(payload: unknown): RuntimeOperation {
  if (
    payload !== null
    && typeof payload === "object"
    && !Array.isArray(payload)
    && isRuntimeOperation((payload as Record<string, unknown>).operation)
  ) {
    return (payload as Record<string, unknown>).operation as RuntimeOperation;
  }
  return "workspace.inspect";
}

function isRuntimeOperationResponse(
  value: RuntimeOperationRequest | RuntimeOperationResponse,
): value is RuntimeOperationResponse {
  return "status" in value;
}

function responseFromResult(
  operation: RuntimeOperation,
  result: { readonly result: SemanticResult<unknown> },
): RuntimeOperationResponse {
  if (!result.result.ok) {
    return runtimeOperationFailure(
      operation,
      result.result.error.code,
      result.result.error.message,
      result.result.error.details,
    );
  }
  try {
    return parseRuntimeOperationResponse({
      schemaVersion: 1,
      status: "ok",
      operation,
      value: result.result.value as ModuleJsonValue,
    });
  } catch {
    return runtimeOperationFailure(
      operation,
      "runtime.operation.invalid-response",
      "Runtime operation produced a non-JSON-safe response.",
    );
  }
}
