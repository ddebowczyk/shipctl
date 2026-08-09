import type { MessageTypeId } from "./messages";

export const SCHEDULE_SCHEMA_VERSION = 1 as const;
export const SCHEDULE_INSPECTION_SCHEMA_VERSION = 1 as const;

export const SCHEDULE_DIAGNOSTIC_CODES = {
  sourcePathUnsafe: "scheduler.source.path_unsafe",
  sourceNotRegular: "scheduler.source.not_regular",
  sourceUnknownField: "scheduler.source.unknown_field",
  sourceInvalid: "scheduler.source.invalid",
  schemaVersionUnsupported: "scheduler.source.schema_version_unsupported",
  identifierInvalid: "scheduler.definition.identifier_invalid",
  cronTimezoneRequired: "scheduler.definition.cron_timezone_required",
  cronInvalid: "scheduler.definition.cron_invalid",
  nextOccurrenceUnavailable: "scheduler.definition.next_occurrence_unavailable",
  scheduleDisabled: "scheduler.definition.disabled",
  scheduleNotFound: "scheduler.definition.not_found",
  duplicateId: "scheduler.snapshot.duplicate_id",
  sourceDrift: "scheduler.snapshot.source_drift",
  targetUnavailable: "scheduler.target.unavailable",
  targetMessageIncompatible: "scheduler.target.message_incompatible",
  targetUnauthorized: "scheduler.target.unauthorized",
  payloadInvalid: "scheduler.message.payload_invalid",
  payloadTooLarge: "scheduler.message.payload_too_large",
  secretPayloadForbidden: "scheduler.message.secret_payload_forbidden",
  diagnosticSecretLeakage: "scheduler.diagnostic.secret_leakage",
} as const;

export type ScheduleDiagnosticCode =
  (typeof SCHEDULE_DIAGNOSTIC_CODES)[keyof typeof SCHEDULE_DIAGNOSTIC_CODES];

export type ScheduleTargetKind = "channel" | "topic";
export type ScheduleTargetAvailability = "unknown" | "available" | "unavailable";
export type ScheduleDeliveryOutcome = "delivered" | "failed";
export type ScheduleDiagnosticSeverity = "error" | "warning";

export interface ScheduleTarget {
  readonly kind: ScheduleTargetKind;
  readonly id: string;
}

export interface ScheduleDiagnostic {
  readonly schemaVersion: typeof SCHEDULE_INSPECTION_SCHEMA_VERSION;
  readonly code: ScheduleDiagnosticCode;
  readonly severity: ScheduleDiagnosticSeverity;
  readonly sourcePath?: string;
  readonly scheduleId?: string;
  readonly context: {
    readonly fields?: Readonly<Record<string, string>>;
  };
}

export interface ScheduleDeliverySummary {
  readonly occurrenceUtc: string;
  readonly outcome: ScheduleDeliveryOutcome;
  readonly routeGeneration: number;
  readonly diagnostic?: ScheduleDiagnostic;
}

export interface ScheduleDefinitionInspection {
  readonly id: string;
  readonly enabled: boolean;
  readonly schemaVersion: typeof SCHEDULE_SCHEMA_VERSION;
  readonly definitionDigestSha256: string;
  readonly sourcePath: string;
  readonly cron: string;
  readonly timezone: string;
  readonly target: ScheduleTarget;
  readonly message: MessageTypeId;
  readonly scheduleGeneration: number;
  readonly busRouteGeneration: number;
  readonly nextOccurrenceUtc?: string;
  readonly lastAttempt?: ScheduleDeliverySummary;
  readonly targetAvailability: ScheduleTargetAvailability;
  readonly diagnostic?: ScheduleDiagnostic;
}

export interface ScheduleInspection {
  readonly schemaVersion: typeof SCHEDULE_INSPECTION_SCHEMA_VERSION;
  readonly instanceId: string;
  readonly incarnation: string;
  readonly scheduleGeneration: number;
  readonly snapshotDigestSha256: string;
  readonly busRouteGeneration: number;
  readonly schedules: readonly ScheduleDefinitionInspection[];
  readonly diagnostics: readonly ScheduleDiagnostic[];
}

export class ScheduleInspectionParseError extends Error {
  readonly code: ScheduleDiagnosticCode;

  constructor(code: ScheduleDiagnosticCode, message: string) {
    super(message);
    this.name = "ScheduleInspectionParseError";
    this.code = code;
  }
}

export function parseScheduleInspection(value: unknown): ScheduleInspection {
  const object = strictObject(value, [
    "schemaVersion",
    "instanceId",
    "incarnation",
    "scheduleGeneration",
    "snapshotDigestSha256",
    "busRouteGeneration",
    "schedules",
    "diagnostics",
  ]);
  requireInspectionSchemaVersion(object.schemaVersion);
  const schedules = array(object.schedules).map(parseScheduleDefinitionInspection);
  const scheduleIds = new Set<string>();
  for (const schedule of schedules) {
    if (scheduleIds.has(schedule.id)) {
      fail(SCHEDULE_DIAGNOSTIC_CODES.duplicateId, "inspection contains a duplicate schedule id");
    }
    scheduleIds.add(schedule.id);
  }

  return {
    schemaVersion: SCHEDULE_INSPECTION_SCHEMA_VERSION,
    instanceId: nonemptyString(object.instanceId),
    incarnation: nonemptyString(object.incarnation),
    scheduleGeneration: unsignedInteger(object.scheduleGeneration),
    snapshotDigestSha256: sha256Digest(object.snapshotDigestSha256),
    busRouteGeneration: unsignedInteger(object.busRouteGeneration),
    schedules,
    diagnostics: array(object.diagnostics).map(parseScheduleDiagnostic),
  };
}

function parseScheduleDefinitionInspection(value: unknown): ScheduleDefinitionInspection {
  const object = strictObject(
    value,
    [
      "id",
      "enabled",
      "schemaVersion",
      "definitionDigestSha256",
      "sourcePath",
      "cron",
      "timezone",
      "target",
      "message",
      "scheduleGeneration",
      "busRouteGeneration",
      "targetAvailability",
    ],
    ["nextOccurrenceUtc", "lastAttempt", "diagnostic"],
  );
  requireScheduleSchemaVersion(object.schemaVersion);
  return {
    id: scopedId(object.id),
    enabled: boolean(object.enabled),
    schemaVersion: SCHEDULE_SCHEMA_VERSION,
    definitionDigestSha256: sha256Digest(object.definitionDigestSha256),
    sourcePath: scheduleSourcePath(object.sourcePath),
    cron: nonemptyString(object.cron),
    timezone: ianaTimezone(object.timezone),
    target: parseScheduleTarget(object.target),
    message: parseMessageTypeId(object.message),
    scheduleGeneration: unsignedInteger(object.scheduleGeneration),
    busRouteGeneration: unsignedInteger(object.busRouteGeneration),
    ...(object.nextOccurrenceUtc === undefined
      ? {}
      : { nextOccurrenceUtc: nonemptyString(object.nextOccurrenceUtc) }),
    ...(object.lastAttempt === undefined
      ? {}
      : { lastAttempt: parseScheduleDeliverySummary(object.lastAttempt) }),
    targetAvailability: parseTargetAvailability(object.targetAvailability),
    ...(object.diagnostic === undefined
      ? {}
      : { diagnostic: parseScheduleDiagnostic(object.diagnostic) }),
  };
}

function parseScheduleDeliverySummary(value: unknown): ScheduleDeliverySummary {
  const object = strictObject(
    value,
    ["occurrenceUtc", "outcome", "routeGeneration"],
    ["diagnostic"],
  );
  return {
    occurrenceUtc: nonemptyString(object.occurrenceUtc),
    outcome: parseDeliveryOutcome(object.outcome),
    routeGeneration: unsignedInteger(object.routeGeneration),
    ...(object.diagnostic === undefined
      ? {}
      : { diagnostic: parseScheduleDiagnostic(object.diagnostic) }),
  };
}

function parseScheduleDiagnostic(value: unknown): ScheduleDiagnostic {
  const object = strictObject(
    value,
    ["schemaVersion", "code", "severity", "context"],
    ["sourcePath", "scheduleId"],
  );
  requireInspectionSchemaVersion(object.schemaVersion);
  const context = strictObject(object.context, [], ["fields"]);
  const fields = context.fields === undefined ? undefined : stringRecord(context.fields);
  for (const [key, fieldValue] of Object.entries(fields ?? {})) {
    const sensitiveKey = /secret|token|password|credential|authorization|api_key/i.test(key);
    const sensitiveValue = /bearer |ghp_|sk-|xoxb_/i.test(fieldValue);
    if ((sensitiveKey && fieldValue !== "[redacted]") || sensitiveValue) {
      fail(
        SCHEDULE_DIAGNOSTIC_CODES.diagnosticSecretLeakage,
        `diagnostic field ${key} is not redacted`,
      );
    }
  }
  return {
    schemaVersion: SCHEDULE_INSPECTION_SCHEMA_VERSION,
    code: diagnosticCode(object.code),
    severity: parseDiagnosticSeverity(object.severity),
    ...(object.sourcePath === undefined ? {} : { sourcePath: scheduleSourcePath(object.sourcePath) }),
    ...(object.scheduleId === undefined ? {} : { scheduleId: scopedId(object.scheduleId) }),
    context: fields === undefined ? {} : { fields },
  };
}

function parseScheduleTarget(value: unknown): ScheduleTarget {
  const object = strictObject(value, ["kind", "id"]);
  return {
    kind: parseTargetKind(object.kind),
    id: scopedId(object.id),
  };
}

function parseMessageTypeId(value: unknown): MessageTypeId {
  const object = strictObject(value, ["id", "version"]);
  return {
    id: scopedId(object.id),
    version: nonzeroUnsignedInteger(object.version),
  };
}

function parseTargetKind(value: unknown): ScheduleTargetKind {
  if (value === "channel" || value === "topic") return value;
  fail(SCHEDULE_DIAGNOSTIC_CODES.sourceInvalid, "invalid schedule target kind");
}

function parseTargetAvailability(value: unknown): ScheduleTargetAvailability {
  if (value === "unknown" || value === "available" || value === "unavailable") return value;
  fail(SCHEDULE_DIAGNOSTIC_CODES.sourceInvalid, "invalid schedule target availability");
}

function parseDeliveryOutcome(value: unknown): ScheduleDeliveryOutcome {
  if (value === "delivered" || value === "failed") return value;
  fail(SCHEDULE_DIAGNOSTIC_CODES.sourceInvalid, "invalid schedule delivery outcome");
}

function parseDiagnosticSeverity(value: unknown): ScheduleDiagnosticSeverity {
  if (value === "error" || value === "warning") return value;
  fail(SCHEDULE_DIAGNOSTIC_CODES.sourceInvalid, "invalid schedule diagnostic severity");
}

function diagnosticCode(value: unknown): ScheduleDiagnosticCode {
  const code = nonemptyString(value);
  if (!Object.values(SCHEDULE_DIAGNOSTIC_CODES).includes(code as ScheduleDiagnosticCode)) {
    fail(SCHEDULE_DIAGNOSTIC_CODES.sourceInvalid, "unknown schedule diagnostic code");
  }
  return code as ScheduleDiagnosticCode;
}

function strictObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) fail(SCHEDULE_DIAGNOSTIC_CODES.sourceInvalid, "expected an object");
  for (const key of required) {
    if (!hasOwn(value, key)) fail(SCHEDULE_DIAGNOSTIC_CODES.sourceInvalid, `missing ${key}`);
  }
  const accepted = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) {
      fail(SCHEDULE_DIAGNOSTIC_CODES.sourceUnknownField, `unknown field ${key}`);
    }
  }
  return value;
}

function requireInspectionSchemaVersion(value: unknown): void {
  if (value !== SCHEDULE_INSPECTION_SCHEMA_VERSION) {
    fail(SCHEDULE_DIAGNOSTIC_CODES.schemaVersionUnsupported, "unsupported inspection schemaVersion");
  }
}

function requireScheduleSchemaVersion(value: unknown): void {
  if (value !== SCHEDULE_SCHEMA_VERSION) {
    fail(SCHEDULE_DIAGNOSTIC_CODES.schemaVersionUnsupported, "unsupported schedule schemaVersion");
  }
}

function scheduleSourcePath(value: unknown): string {
  const path = nonemptyString(value);
  if (
    path.includes("/") ||
    path.includes("\\") ||
    (!path.endsWith(".yaml") && !path.endsWith(".yml"))
  ) {
    fail(SCHEDULE_DIAGNOSTIC_CODES.sourcePathUnsafe, "invalid schedule source path");
  }
  return path;
}

function ianaTimezone(value: unknown): string {
  const timezone = nonemptyString(value);
  if (!timezone.includes("/")) {
    fail(SCHEDULE_DIAGNOSTIC_CODES.cronTimezoneRequired, "schedule timezone must be explicit");
  }
  return timezone;
}

function sha256Digest(value: unknown): string {
  const digest = nonemptyString(value);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    fail(SCHEDULE_DIAGNOSTIC_CODES.sourceInvalid, "expected a SHA-256 digest");
  }
  return digest;
}

function scopedId(value: unknown): string {
  const id = nonemptyString(value);
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(id)) {
    fail(SCHEDULE_DIAGNOSTIC_CODES.identifierInvalid, "invalid scoped identifier");
  }
  return id;
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) fail(SCHEDULE_DIAGNOSTIC_CODES.sourceInvalid, "expected diagnostic fields");
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) result[key] = nonemptyString(item);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) fail(SCHEDULE_DIAGNOSTIC_CODES.sourceInvalid, "expected an array");
  return value;
}

function nonemptyString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(SCHEDULE_DIAGNOSTIC_CODES.sourceInvalid, "expected a non-empty string");
  }
  return value;
}

function unsignedInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(SCHEDULE_DIAGNOSTIC_CODES.sourceInvalid, "expected an unsigned integer");
  }
  return value;
}

function nonzeroUnsignedInteger(value: unknown): number {
  const integer = unsignedInteger(value);
  if (integer === 0) fail(SCHEDULE_DIAGNOSTIC_CODES.identifierInvalid, "message version must be non-zero");
  return integer;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") fail(SCHEDULE_DIAGNOSTIC_CODES.sourceInvalid, "expected a boolean");
  return value;
}

function fail(code: ScheduleDiagnosticCode, message: string): never {
  throw new ScheduleInspectionParseError(code, message);
}
