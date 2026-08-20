import {
  isHostConfigurationKey,
  type HostConfigurationKey,
} from "./configuration.ts";
import type { ModuleJsonValue } from "./services.ts";

/** Stable wire version shared by online capability calls and headless execution. */
export const RUNTIME_OPERATION_SCHEMA_VERSION = 1 as const;

export const RUNTIME_WORKSPACE_OPERATIONS = [
  "workspace.inspect",
  "workspace.validate",
  "workspace.plan",
  "workspace.apply",
  "workspace.mutate",
] as const;

export const RUNTIME_CONFIGURATION_OPERATIONS = [
  "configuration.inspect",
  "configuration.resolve",
  "configuration.update",
] as const;

export const RUNTIME_OPERATIONS = [
  ...RUNTIME_WORKSPACE_OPERATIONS,
  ...RUNTIME_CONFIGURATION_OPERATIONS,
] as const;

export type WorkspaceRuntimeOperation = (typeof RUNTIME_WORKSPACE_OPERATIONS)[number];
export type ConfigurationRuntimeOperation = (typeof RUNTIME_CONFIGURATION_OPERATIONS)[number];
export type RuntimeOperation = (typeof RUNTIME_OPERATIONS)[number];

export interface InspectWorkspaceRuntimeOperationRequest {
  readonly schemaVersion: typeof RUNTIME_OPERATION_SCHEMA_VERSION;
  readonly operation: "workspace.inspect";
  readonly workspaceId: string;
  readonly includeDocument: boolean;
}

export interface WorkspaceCommandRuntimeOperationRequest {
  readonly schemaVersion: typeof RUNTIME_OPERATION_SCHEMA_VERSION;
  readonly operation: Exclude<WorkspaceRuntimeOperation, "workspace.inspect">;
  readonly workspaceId: string;
  /** Workspace owns the detailed command grammar and validates it on execution. */
  readonly command: ModuleJsonValue;
}

export interface InspectConfigurationRuntimeOperationRequest {
  readonly schemaVersion: typeof RUNTIME_OPERATION_SCHEMA_VERSION;
  readonly operation: "configuration.inspect" | "configuration.resolve";
  readonly key: HostConfigurationKey;
}

export interface UpdateConfigurationRuntimeOperationRequest {
  readonly schemaVersion: typeof RUNTIME_OPERATION_SCHEMA_VERSION;
  readonly operation: "configuration.update";
  readonly key: HostConfigurationKey;
  readonly value: ModuleJsonValue;
}

export type RuntimeOperationRequest =
  | InspectWorkspaceRuntimeOperationRequest
  | WorkspaceCommandRuntimeOperationRequest
  | InspectConfigurationRuntimeOperationRequest
  | UpdateConfigurationRuntimeOperationRequest;

export interface RuntimeOperationSuccess {
  readonly schemaVersion: typeof RUNTIME_OPERATION_SCHEMA_VERSION;
  readonly status: "ok";
  readonly operation: RuntimeOperation;
  readonly value: ModuleJsonValue;
}

export interface RuntimeOperationFailure {
  readonly schemaVersion: typeof RUNTIME_OPERATION_SCHEMA_VERSION;
  readonly status: "error";
  readonly operation: RuntimeOperation;
  readonly code: string;
  readonly message: string;
  readonly details?: ModuleJsonValue;
}

export interface RuntimeOperationUnavailable {
  readonly schemaVersion: typeof RUNTIME_OPERATION_SCHEMA_VERSION;
  readonly status: "unavailable";
  readonly operation: RuntimeOperation;
  readonly code: "runtime.operation.unavailable";
  readonly message: string;
  readonly details?: ModuleJsonValue;
}

export type RuntimeOperationResponse =
  | RuntimeOperationSuccess
  | RuntimeOperationFailure
  | RuntimeOperationUnavailable;

export const RUNTIME_OPERATION_DIAGNOSTIC_CODES = {
  invalidRequest: "runtime.operation.invalid-request",
  invalidResponse: "runtime.operation.invalid-response",
  unavailable: "runtime.operation.unavailable",
} as const;

export type RuntimeOperationDiagnosticCode =
  (typeof RUNTIME_OPERATION_DIAGNOSTIC_CODES)[keyof typeof RUNTIME_OPERATION_DIAGNOSTIC_CODES];

/** A malformed wire payload is rejected before it can reach a semantic provider. */
export class RuntimeOperationParseError extends Error {
  readonly code: RuntimeOperationDiagnosticCode;

  constructor(code: RuntimeOperationDiagnosticCode, message: string) {
    super(message);
    this.name = "RuntimeOperationParseError";
    this.code = code;
  }
}

export function isRuntimeOperation(value: unknown): value is RuntimeOperation {
  return typeof value === "string" && (RUNTIME_OPERATIONS as readonly string[]).includes(value);
}

export function isWorkspaceRuntimeOperation(value: unknown): value is WorkspaceRuntimeOperation {
  return typeof value === "string"
    && (RUNTIME_WORKSPACE_OPERATIONS as readonly string[]).includes(value);
}

export function isConfigurationRuntimeOperation(
  value: unknown,
): value is ConfigurationRuntimeOperation {
  return typeof value === "string"
    && (RUNTIME_CONFIGURATION_OPERATIONS as readonly string[]).includes(value);
}

/**
 * Parses only the operation envelope. Workspace command grammar and
 * configuration value semantics remain behind their corresponding services.
 */
export function parseRuntimeOperationRequest(value: unknown): RuntimeOperationRequest {
  const base = record(value, RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidRequest);
  requireSchemaVersion(base.schemaVersion, RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidRequest);
  const operation = runtimeOperation(base.operation, RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidRequest);

  switch (operation) {
    case "workspace.inspect": {
      const input = strictRecord(value, [
        "schemaVersion",
        "operation",
        "workspaceId",
        "includeDocument",
      ]);
      return Object.freeze({
        schemaVersion: RUNTIME_OPERATION_SCHEMA_VERSION,
        operation,
        workspaceId: identity(input.workspaceId, "workspaceId", RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidRequest),
        includeDocument: boolean(input.includeDocument, "includeDocument", RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidRequest),
      });
    }
    case "workspace.validate":
    case "workspace.plan":
    case "workspace.apply":
    case "workspace.mutate": {
      const input = strictRecord(value, ["schemaVersion", "operation", "workspaceId", "command"]);
      return Object.freeze({
        schemaVersion: RUNTIME_OPERATION_SCHEMA_VERSION,
        operation,
        workspaceId: identity(input.workspaceId, "workspaceId", RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidRequest),
        command: moduleJson(input.command, "command", RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidRequest),
      });
    }
    case "configuration.inspect":
    case "configuration.resolve": {
      const input = strictRecord(value, ["schemaVersion", "operation", "key"]);
      return Object.freeze({
        schemaVersion: RUNTIME_OPERATION_SCHEMA_VERSION,
        operation,
        key: configurationKey(input.key, RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidRequest),
      });
    }
    case "configuration.update": {
      const input = strictRecord(value, ["schemaVersion", "operation", "key", "value"]);
      return Object.freeze({
        schemaVersion: RUNTIME_OPERATION_SCHEMA_VERSION,
        operation,
        key: configurationKey(input.key, RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidRequest),
        value: moduleJson(input.value, "value", RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidRequest),
      });
    }
  }
}

export function parseRuntimeOperationResponse(value: unknown): RuntimeOperationResponse {
  const base = record(value, RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidResponse);
  requireSchemaVersion(base.schemaVersion, RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidResponse);
  const operation = runtimeOperation(base.operation, RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidResponse);

  switch (base.status) {
    case "ok": {
      const response = strictRecord(
        value,
        ["schemaVersion", "status", "operation", "value"],
        [],
        RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidResponse,
      );
      return Object.freeze({
        schemaVersion: RUNTIME_OPERATION_SCHEMA_VERSION,
        status: "ok",
        operation,
        value: moduleJson(response.value, "value", RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidResponse),
      });
    }
    case "error": {
      const response = strictRecord(
        value,
        ["schemaVersion", "status", "operation", "code", "message"],
        ["details"],
        RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidResponse,
      );
      const details = response.details === undefined
        ? undefined
        : moduleJson(response.details, "details", RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidResponse);
      return Object.freeze({
        schemaVersion: RUNTIME_OPERATION_SCHEMA_VERSION,
        status: "error",
        operation,
        code: diagnosticCode(response.code, RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidResponse),
        message: text(response.message, "message", RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidResponse),
        ...(details === undefined ? {} : { details }),
      });
    }
    case "unavailable": {
      const response = strictRecord(
        value,
        ["schemaVersion", "status", "operation", "code", "message"],
        ["details"],
        RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidResponse,
      );
      if (response.code !== RUNTIME_OPERATION_DIAGNOSTIC_CODES.unavailable) {
        fail(
          RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidResponse,
          "Unavailable operation response has an invalid code.",
        );
      }
      const details = response.details === undefined
        ? undefined
        : moduleJson(response.details, "details", RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidResponse);
      return Object.freeze({
        schemaVersion: RUNTIME_OPERATION_SCHEMA_VERSION,
        status: "unavailable",
        operation,
        code: RUNTIME_OPERATION_DIAGNOSTIC_CODES.unavailable,
        message: text(response.message, "message", RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidResponse),
        ...(details === undefined ? {} : { details }),
      });
    }
    default:
      return fail(
        RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidResponse,
        "Runtime operation response status is invalid.",
      );
  }
}

export function runtimeOperationSuccess(
  operation: RuntimeOperation,
  value: ModuleJsonValue,
): RuntimeOperationSuccess {
  return parseRuntimeOperationResponse({
    schemaVersion: RUNTIME_OPERATION_SCHEMA_VERSION,
    status: "ok",
    operation,
    value,
  }) as RuntimeOperationSuccess;
}

export function runtimeOperationFailure(
  operation: RuntimeOperation,
  code: string,
  message: string,
  details?: ModuleJsonValue,
): RuntimeOperationFailure {
  return parseRuntimeOperationResponse({
    schemaVersion: RUNTIME_OPERATION_SCHEMA_VERSION,
    status: "error",
    operation,
    code,
    message,
    ...(details === undefined ? {} : { details }),
  }) as RuntimeOperationFailure;
}

export function runtimeOperationUnavailable(
  operation: RuntimeOperation,
  message: string,
  details?: ModuleJsonValue,
): RuntimeOperationUnavailable {
  return parseRuntimeOperationResponse({
    schemaVersion: RUNTIME_OPERATION_SCHEMA_VERSION,
    status: "unavailable",
    operation,
    code: RUNTIME_OPERATION_DIAGNOSTIC_CODES.unavailable,
    message,
    ...(details === undefined ? {} : { details }),
  }) as RuntimeOperationUnavailable;
}

function strictRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
  code: RuntimeOperationDiagnosticCode = RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidRequest,
): Record<string, unknown> {
  const object = record(value, code);
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(object);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !(key in object))) {
    return fail(code, "Runtime operation payload has unsupported fields.");
  }
  return object;
}

function record(
  value: unknown,
  code: RuntimeOperationDiagnosticCode,
): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    return fail(code, "Runtime operation payload must be an object.");
  }
  return value;
}

function requireSchemaVersion(value: unknown, code: RuntimeOperationDiagnosticCode): void {
  if (value !== RUNTIME_OPERATION_SCHEMA_VERSION) {
    fail(code, "Runtime operation schemaVersion is unsupported.");
  }
}

function runtimeOperation(value: unknown, code: RuntimeOperationDiagnosticCode): RuntimeOperation {
  if (!isRuntimeOperation(value)) fail(code, "Runtime operation is invalid.");
  return value;
}

function configurationKey(value: unknown, code: RuntimeOperationDiagnosticCode): HostConfigurationKey {
  if (!isHostConfigurationKey(value)) fail(code, "Configuration key is invalid.");
  return value;
}

function identity(value: unknown, label: string, code: RuntimeOperationDiagnosticCode): string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(code, `${label} is invalid.`);
  }
  return value;
}

function boolean(value: unknown, label: string, code: RuntimeOperationDiagnosticCode): boolean {
  if (typeof value !== "boolean") fail(code, `${label} must be boolean.`);
  return value;
}

function text(value: unknown, label: string, code: RuntimeOperationDiagnosticCode): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(code, `${label} is invalid.`);
  return value;
}

function diagnosticCode(value: unknown, code: RuntimeOperationDiagnosticCode): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]*(?:[._-][a-z0-9-]+)*$/.test(value)) {
    fail(code, "Runtime operation diagnostic code is invalid.");
  }
  return value;
}

function moduleJson(
  value: unknown,
  label: string,
  code: RuntimeOperationDiagnosticCode,
): ModuleJsonValue {
  if (!isModuleJsonValue(value)) fail(code, `${label} must be JSON-safe.`);
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isModuleJsonValue(value: unknown, ancestors = new Set<object>()): value is ModuleJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!Array.isArray(value) && !isPlainRecord(value)) return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isModuleJsonValue(item, ancestors))
    : Object.values(value).every((item) => isModuleJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function fail(code: RuntimeOperationDiagnosticCode, message: string): never {
  throw new RuntimeOperationParseError(code, message);
}
