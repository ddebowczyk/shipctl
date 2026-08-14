export const MESSAGE_CONTRACT_SCHEMA_VERSION = 1 as const;
export const JSON_SCHEMA_DRAFT_2020_12 =
  "https://json-schema.org/draft/2020-12/schema" as const;

export const MESSAGE_DIAGNOSTIC_CODES = {
  schemaVersionUnsupported: "message.contract.schema_version_unsupported",
  unknownField: "message.contract.unknown_field",
  invalidJson: "message.contract.invalid_json",
  invalidIdentifier: "message.contract.identifier.invalid",
  invalidSchema: "message.contract.schema.invalid",
  schemaReferenceForbidden: "message.contract.schema.reference_forbidden",
  boundRequired: "message.contract.bound.required",
  unknownMessageContract: "message.contract.unknown",
  incompatibleMessageVersion: "message.contract.version.incompatible",
  invalidPayload: "message.payload.invalid",
  payloadTooLarge: "message.payload.too_large",
  unauthorizedSender: "message.sender.unauthorized",
  noActiveChannelOwner: "message.channel.owner.absent",
  duplicateChannelOwner: "message.channel.owner.duplicate",
  subscriberLag: "message.topic.subscriber.lag",
  handlerUnavailable: "message.handler.unavailable",
  handlerFailed: "message.handler.failed",
  routeGenerationChanged: "message.route.generation_changed",
  bridgeClosed: "message.bridge.closed",
  secretLeakage: "message.diagnostic.secret_leakage",
} as const;

export type MessageDiagnosticCode =
  (typeof MESSAGE_DIAGNOSTIC_CODES)[keyof typeof MESSAGE_DIAGNOSTIC_CODES];

export interface MessageTypeId {
  readonly id: string;
  readonly version: number;
}

export interface MessageSchemaDescriptor {
  readonly draft: typeof JSON_SCHEMA_DRAFT_2020_12;
  readonly root: string;
  readonly resources: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly maxEncodedBytes: number;
  readonly redactedFields: readonly string[];
  readonly compatibleVersions: readonly number[];
}

export interface MessageTypeContract<Payload = unknown> {
  readonly message: MessageRef<Payload>;
  readonly schema: MessageSchemaDescriptor;
}

export interface MessageRef<Payload> extends MessageTypeId {
  readonly __payload?: Payload;
}

export interface DirectedChannel<Payload> {
  readonly id: string;
  readonly message: MessageRef<Payload>;
}

export interface BroadcastTopic<Payload> {
  readonly id: string;
  readonly message: MessageRef<Payload>;
}

export interface CapabilityPort<Request, Response> {
  readonly id: string;
  readonly request: MessageRef<Request>;
  readonly response: MessageRef<Response>;
}

export interface DeliveryReceipt {
  readonly schemaVersion: typeof MESSAGE_CONTRACT_SCHEMA_VERSION;
  readonly endpoint: string;
  readonly message: MessageTypeId;
  readonly routeGeneration: number;
}

export interface PublishReceipt extends DeliveryReceipt {
  readonly subscriberCount: number;
}

export interface ModuleMessages {
  send<Payload>(
    channel: DirectedChannel<Payload>,
    payload: Payload,
  ): Promise<DeliveryReceipt>;
  publish<Payload>(
    topic: BroadcastTopic<Payload>,
    payload: Payload,
  ): Promise<PublishReceipt>;
  request<Request, Response>(
    port: CapabilityPort<Request, Response>,
    payload: Request,
  ): Promise<Response>;
}

export interface DirectedMessageHandler<Payload> {
  readonly channel: DirectedChannel<Payload>;
  readonly capacity: number;
  readonly requiredGrant: string;
  readonly schedulerAllowed: boolean;
  handle(payload: Payload): void | Promise<void>;
}

export interface BroadcastMessagePublisher<Payload> {
  readonly topic: BroadcastTopic<Payload>;
  readonly capacity: number;
  readonly requiredGrant: string;
  readonly schedulerAllowed: boolean;
}

export interface BroadcastMessageSubscription<Payload> {
  readonly topic: BroadcastTopic<Payload>;
  handle(payload: Payload): void | Promise<void>;
}

export interface CapabilityPortHandler<Request, Response> {
  readonly port: CapabilityPort<Request, Response>;
  readonly capacity: number;
  readonly requiredGrant: string;
  readonly schedulerAllowed: boolean;
  handle(request: Request): Response | Promise<Response>;
}

export interface ModuleMessageContributions {
  readonly provides?: readonly MessageTypeContract<unknown>[];
  readonly handles?: readonly DirectedMessageHandler<unknown>[];
  readonly publishes?: readonly BroadcastMessagePublisher<unknown>[];
  readonly subscribes?: readonly BroadcastMessageSubscription<unknown>[];
  readonly ports?: readonly CapabilityPortHandler<unknown, unknown>[];
}

export interface MessageEnvelope {
  readonly schemaVersion: typeof MESSAGE_CONTRACT_SCHEMA_VERSION;
  readonly endpoint: string;
  readonly message: MessageTypeId;
  readonly payload: unknown;
  readonly correlationId?: string;
}

export interface RouteEndpointRef {
  readonly id: string;
  readonly message: MessageTypeId;
}

export interface DirectedRoute {
  readonly endpoint: RouteEndpointRef;
  readonly ownerActivationId: string;
  readonly capacity: number;
  readonly schedulerAllowed: boolean;
}

export interface BroadcastRoute {
  readonly endpoint: RouteEndpointRef;
  readonly subscriberCount: number;
  readonly capacity: number;
  readonly schedulerAllowed: boolean;
}

export interface CapabilityRoute {
  readonly id: string;
  readonly request: MessageTypeId;
  readonly response: MessageTypeId;
  readonly ownerActivationId: string;
  readonly capacity: number;
  readonly schedulerAllowed: boolean;
}

export interface MessageRouteSnapshot {
  readonly schemaVersion: typeof MESSAGE_CONTRACT_SCHEMA_VERSION;
  readonly instanceId: string;
  readonly incarnation: string;
  readonly routeGeneration: number;
  readonly channels: readonly DirectedRoute[];
  readonly topics: readonly BroadcastRoute[];
  readonly ports: readonly CapabilityRoute[];
}

export interface MessageObservation {
  readonly schemaVersion: typeof MESSAGE_CONTRACT_SCHEMA_VERSION;
  readonly code: MessageDiagnosticCode;
  readonly endpoint?: string;
  readonly message?: MessageTypeId;
  readonly routeGeneration: number;
  readonly context: {
    readonly fields?: Readonly<Record<string, string>>;
  };
}

export interface WireDirectedChannelDeclaration {
  readonly endpoint: RouteEndpointRef;
  readonly capacity: number;
  readonly requiredGrant: string;
  readonly schedulerAllowed: boolean;
}

export interface WireBroadcastTopicDeclaration {
  readonly endpoint: RouteEndpointRef;
  readonly capacity: number;
  readonly requiredGrant: string;
  readonly schedulerAllowed: boolean;
}

export interface WireCapabilityPortDeclaration {
  readonly id: string;
  readonly request: MessageTypeId;
  readonly response: MessageTypeId;
  readonly capacity: number;
  readonly requiredGrant: string;
  readonly schedulerAllowed: boolean;
}

export interface MessageDeclarations {
  readonly schemaVersion: typeof MESSAGE_CONTRACT_SCHEMA_VERSION;
  readonly provides: readonly MessageTypeContract<unknown>[];
  readonly handles: readonly WireDirectedChannelDeclaration[];
  readonly publishes: readonly WireBroadcastTopicDeclaration[];
  readonly subscribes: readonly RouteEndpointRef[];
  readonly ports: readonly WireCapabilityPortDeclaration[];
}

export class MessageContractParseError extends Error {
  readonly code: MessageDiagnosticCode;

  constructor(code: MessageDiagnosticCode, message: string) {
    super(message);
    this.name = "MessageContractParseError";
    this.code = code;
  }
}

export function parseMessageEnvelope(value: unknown): MessageEnvelope {
  const object = strictObject(
    value,
    ["schemaVersion", "endpoint", "message", "payload"],
    ["correlationId"],
  );
  requireSchemaVersion(object.schemaVersion);
  const endpoint = scopedId(object.endpoint);
  const message = parseMessageTypeId(object.message);
  const correlationId = optionalString(object.correlationId);
  if (correlationId !== undefined && correlationId.length === 0) {
    fail(MESSAGE_DIAGNOSTIC_CODES.invalidIdentifier, "correlationId cannot be empty");
  }
  return {
    schemaVersion: MESSAGE_CONTRACT_SCHEMA_VERSION,
    endpoint,
    message,
    payload: object.payload,
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

export function parseDeliveryReceipt(value: unknown): DeliveryReceipt {
  const object = strictObject(
    value,
    ["schemaVersion", "endpoint", "message", "routeGeneration"],
  );
  requireSchemaVersion(object.schemaVersion);
  return {
    schemaVersion: MESSAGE_CONTRACT_SCHEMA_VERSION,
    endpoint: scopedId(object.endpoint),
    message: parseMessageTypeId(object.message),
    routeGeneration: unsignedInteger(object.routeGeneration),
  };
}

export function parsePublishReceipt(value: unknown): PublishReceipt {
  const object = strictObject(
    value,
    ["schemaVersion", "endpoint", "message", "routeGeneration", "subscriberCount"],
  );
  requireSchemaVersion(object.schemaVersion);
  return {
    schemaVersion: MESSAGE_CONTRACT_SCHEMA_VERSION,
    endpoint: scopedId(object.endpoint),
    message: parseMessageTypeId(object.message),
    routeGeneration: unsignedInteger(object.routeGeneration),
    subscriberCount: unsignedInteger(object.subscriberCount),
  };
}

export function parseMessageDeclarations(value: unknown): MessageDeclarations {
  const object = strictObject(
    value,
    ["schemaVersion", "provides", "handles", "publishes", "subscribes", "ports"],
  );
  requireSchemaVersion(object.schemaVersion);
  const provides = array(object.provides).map(parseMessageTypeContract);
  const known = new Set(provides.map(({ message }) => `${message.id}@${message.version}`));
  const handles = array(object.handles).map((item) => {
    const declaration = strictObject(
      item,
      ["endpoint", "capacity", "requiredGrant", "schedulerAllowed"],
    );
    const endpoint = parseEndpointRef(declaration.endpoint);
    const capacity = nonzeroBound(declaration.capacity);
    if (!known.has(`${endpoint.message.id}@${endpoint.message.version}`)) {
      fail(MESSAGE_DIAGNOSTIC_CODES.unknownMessageContract, "handled message is not provided");
    }
    return {
      endpoint,
      capacity,
      requiredGrant: grantId(declaration.requiredGrant),
      schedulerAllowed: boolean(declaration.schedulerAllowed),
    };
  });
  const publishes = array(object.publishes).map((item) => {
    const declaration = strictObject(item, ["endpoint", "capacity", "requiredGrant", "schedulerAllowed"]);
    const endpoint = parseEndpointRef(declaration.endpoint);
    const capacity = nonzeroBound(declaration.capacity);
    if (!known.has(`${endpoint.message.id}@${endpoint.message.version}`)) {
      fail(MESSAGE_DIAGNOSTIC_CODES.unknownMessageContract, "published message is not provided");
    }
    return {
      endpoint,
      capacity,
      requiredGrant: grantId(declaration.requiredGrant),
      schedulerAllowed: boolean(declaration.schedulerAllowed),
    };
  });
  const subscribes = array(object.subscribes).map(parseEndpointRef);
  const ports = array(object.ports).map((item) => {
    const declaration = strictObject(
      item,
      ["id", "request", "response", "capacity", "requiredGrant", "schedulerAllowed"],
    );
    const request = parseMessageTypeId(declaration.request);
    const response = parseMessageTypeId(declaration.response);
    const capacity = nonzeroBound(declaration.capacity);
    if (
      !known.has(`${request.id}@${request.version}`) ||
      !known.has(`${response.id}@${response.version}`)
    ) {
      fail(MESSAGE_DIAGNOSTIC_CODES.unknownMessageContract, "port messages are not provided");
    }
    return {
      id: scopedId(declaration.id),
      request,
      response,
      capacity,
      requiredGrant: grantId(declaration.requiredGrant),
      schedulerAllowed: boolean(declaration.schedulerAllowed),
    };
  });
  return {
    schemaVersion: MESSAGE_CONTRACT_SCHEMA_VERSION,
    provides,
    handles,
    publishes,
    subscribes,
    ports,
  };
}

export function parseMessageRouteSnapshot(value: unknown): MessageRouteSnapshot {
  const object = strictObject(
    value,
    [
      "schemaVersion",
      "instanceId",
      "incarnation",
      "routeGeneration",
      "channels",
      "topics",
      "ports",
    ],
  );
  requireSchemaVersion(object.schemaVersion);
  return {
    schemaVersion: MESSAGE_CONTRACT_SCHEMA_VERSION,
    instanceId: nonemptyString(object.instanceId),
    incarnation: nonemptyString(object.incarnation),
    routeGeneration: unsignedInteger(object.routeGeneration),
    channels: array(object.channels).map((item) => {
      const route = strictObject(
        item,
        ["endpoint", "ownerActivationId", "capacity", "schedulerAllowed"],
      );
      return {
        endpoint: parseEndpointRef(route.endpoint),
        ownerActivationId: nonemptyString(route.ownerActivationId),
        capacity: nonzeroBound(route.capacity),
        schedulerAllowed: boolean(route.schedulerAllowed),
      };
    }),
    topics: array(object.topics).map((item) => {
      const route = strictObject(item, ["endpoint", "subscriberCount", "capacity", "schedulerAllowed"]);
      return {
        endpoint: parseEndpointRef(route.endpoint),
        subscriberCount: unsignedInteger(route.subscriberCount),
        capacity: nonzeroBound(route.capacity),
        schedulerAllowed: boolean(route.schedulerAllowed),
      };
    }),
    ports: array(object.ports).map((item) => {
      const route = strictObject(item, [
        "id",
        "request",
        "response",
        "ownerActivationId",
        "capacity",
        "schedulerAllowed",
      ]);
      return {
        id: scopedId(route.id),
        request: parseMessageTypeId(route.request),
        response: parseMessageTypeId(route.response),
        ownerActivationId: nonemptyString(route.ownerActivationId),
        capacity: nonzeroBound(route.capacity),
        schedulerAllowed: boolean(route.schedulerAllowed),
      };
    }),
  };
}

export function parseMessageObservation(value: unknown): MessageObservation {
  const object = strictObject(
    value,
    ["schemaVersion", "code", "routeGeneration", "context"],
    ["endpoint", "message"],
  );
  requireSchemaVersion(object.schemaVersion);
  const context = strictObject(object.context, [], ["fields"]);
  const fields = context.fields === undefined ? undefined : stringRecord(context.fields);
  for (const [key, fieldValue] of Object.entries(fields ?? {})) {
    const sensitiveKey = /secret|token|password|credential|authorization|api_key/i.test(key);
    const sensitiveValue = /bearer |ghp_|sk-|xoxb-/i.test(fieldValue);
    if ((sensitiveKey && fieldValue !== "[redacted]") || sensitiveValue) {
      fail(MESSAGE_DIAGNOSTIC_CODES.secretLeakage, `diagnostic field ${key} is not redacted`);
    }
  }
  const code = nonemptyString(object.code);
  if (!Object.values(MESSAGE_DIAGNOSTIC_CODES).includes(code as MessageDiagnosticCode)) {
    fail(MESSAGE_DIAGNOSTIC_CODES.invalidIdentifier, "diagnostic code is unknown");
  }
  return {
    schemaVersion: MESSAGE_CONTRACT_SCHEMA_VERSION,
    code: code as MessageDiagnosticCode,
    ...(object.endpoint === undefined ? {} : { endpoint: scopedId(object.endpoint) }),
    ...(object.message === undefined ? {} : { message: parseMessageTypeId(object.message) }),
    routeGeneration: unsignedInteger(object.routeGeneration),
    context: fields === undefined ? {} : { fields },
  };
}

function parseMessageTypeContract(value: unknown): MessageTypeContract<unknown> {
  const object = strictObject(value, ["message", "schema"]);
  const message = parseMessageTypeId(object.message);
  const schema = strictObject(
    object.schema,
    ["draft", "root", "resources", "maxEncodedBytes", "redactedFields", "compatibleVersions"],
  );
  if (schema.draft !== JSON_SCHEMA_DRAFT_2020_12) {
    fail(MESSAGE_DIAGNOSTIC_CODES.invalidSchema, "unsupported JSON Schema draft");
  }
  const root = artifactPath(schema.root);
  const resources = schemaRecord(schema.resources);
  if (!(root in resources)) {
    fail(MESSAGE_DIAGNOSTIC_CODES.invalidSchema, "schema root is absent");
  }
  for (const [path, resource] of Object.entries(resources)) {
    artifactPath(path);
    if (
      resource.$schema !== JSON_SCHEMA_DRAFT_2020_12 ||
      resource.$id !== `shipctl-artifact:///${path}`
    ) {
      fail(MESSAGE_DIAGNOSTIC_CODES.invalidSchema, "schema metadata is invalid");
    }
    validateSchemaNode(resource, path, resources);
  }
  const maxEncodedBytes = nonzeroBound(schema.maxEncodedBytes);
  const compatibleVersions = array(schema.compatibleVersions).map(nonzeroBound);
  if (new Set(compatibleVersions).size !== compatibleVersions.length) {
    fail(MESSAGE_DIAGNOSTIC_CODES.incompatibleMessageVersion, "versions are duplicated");
  }
  if (!compatibleVersions.includes(message.version)) {
    fail(MESSAGE_DIAGNOSTIC_CODES.incompatibleMessageVersion, "contract version is not compatible");
  }
  const redactedFields = array(schema.redactedFields).map((pointer) => {
    const value = nonemptyString(pointer);
    if (!/^\/(?:[^~]|~[01])*$/.test(value)) {
      fail(MESSAGE_DIAGNOSTIC_CODES.invalidSchema, "redaction is not a JSON pointer");
    }
    return value;
  });
  return {
    message,
    schema: {
      draft: JSON_SCHEMA_DRAFT_2020_12,
      root,
      resources,
      maxEncodedBytes,
      redactedFields,
      compatibleVersions,
    },
  };
}

function parseMessageTypeId(value: unknown): MessageTypeId {
  const object = strictObject(value, ["id", "version"]);
  return { id: scopedId(object.id), version: nonzeroBound(object.version) };
}

function parseEndpointRef(value: unknown): RouteEndpointRef {
  const object = strictObject(value, ["id", "message"]);
  return { id: scopedId(object.id), message: parseMessageTypeId(object.message) };
}

function validateSchemaNode(
  value: unknown,
  sourcePath: string,
  resources: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) validateSchemaNode(item, sourcePath, resources);
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.type === "string" && !["null", "boolean", "object", "array", "number", "string", "integer"].includes(value.type)) {
    fail(MESSAGE_DIAGNOSTIC_CODES.invalidSchema, "schema type is invalid");
  }
  if (typeof value.$ref === "string" && !value.$ref.startsWith("#")) {
    const path = value.$ref.split("#", 1)[0] ?? "";
    if (!path || path.includes(":") || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === "." || part === "..")) {
      fail(MESSAGE_DIAGNOSTIC_CODES.schemaReferenceForbidden, "schema reference escapes artifact");
    }
    const slash = sourcePath.lastIndexOf("/");
    const resolved = slash < 0 ? path : `${sourcePath.slice(0, slash)}/${path}`;
    if (!(resolved in resources)) {
      fail(MESSAGE_DIAGNOSTIC_CODES.invalidSchema, "schema reference is absent");
    }
  }
  for (const child of Object.values(value)) validateSchemaNode(child, sourcePath, resources);
}

function strictObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) fail(MESSAGE_DIAGNOSTIC_CODES.invalidJson, "expected an object");
  for (const key of required) {
    if (!(key in value)) fail(MESSAGE_DIAGNOSTIC_CODES.invalidJson, `missing ${key}`);
  }
  const accepted = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) fail(MESSAGE_DIAGNOSTIC_CODES.unknownField, `unknown field ${key}`);
  }
  return value;
}

function requireSchemaVersion(value: unknown): void {
  if (value !== MESSAGE_CONTRACT_SCHEMA_VERSION) {
    fail(MESSAGE_DIAGNOSTIC_CODES.schemaVersionUnsupported, "unsupported schemaVersion");
  }
}

function scopedId(value: unknown): string {
  const id = nonemptyString(value);
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(id)) {
    fail(MESSAGE_DIAGNOSTIC_CODES.invalidIdentifier, "invalid scoped identifier");
  }
  return id;
}

function grantId(value: unknown): string {
  const id = nonemptyString(value);
  if (!/^message\.(?:send|publish|request|handle|subscribe)(?:\.[a-z][a-z0-9-]*)+$/.test(id)) {
    fail(MESSAGE_DIAGNOSTIC_CODES.invalidIdentifier, "invalid message grant");
  }
  return id;
}

function artifactPath(value: unknown): string {
  const path = nonemptyString(value);
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    fail(MESSAGE_DIAGNOSTIC_CODES.invalidSchema, "invalid artifact path");
  }
  return path;
}

function schemaRecord(value: unknown): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  if (!isRecord(value)) fail(MESSAGE_DIAGNOSTIC_CODES.invalidSchema, "resources must be an object");
  const result: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isRecord(item)) fail(MESSAGE_DIAGNOSTIC_CODES.invalidSchema, "schema resource must be an object");
    result[key] = item;
  }
  return result;
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) fail(MESSAGE_DIAGNOSTIC_CODES.invalidJson, "expected string fields");
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) result[key] = nonemptyString(item);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) fail(MESSAGE_DIAGNOSTIC_CODES.invalidJson, "expected an array");
  return value;
}

function nonemptyString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(MESSAGE_DIAGNOSTIC_CODES.invalidJson, "expected a non-empty string");
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail(MESSAGE_DIAGNOSTIC_CODES.invalidJson, "expected a string");
  return value;
}

function unsignedInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(MESSAGE_DIAGNOSTIC_CODES.invalidJson, "expected an unsigned integer");
  }
  return value;
}

function nonzeroBound(value: unknown): number {
  const number = unsignedInteger(value);
  if (number === 0) fail(MESSAGE_DIAGNOSTIC_CODES.boundRequired, "bound must be non-zero");
  return number;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") fail(MESSAGE_DIAGNOSTIC_CODES.invalidJson, "expected a boolean");
  return value;
}

function fail(code: MessageDiagnosticCode, message: string): never {
  throw new MessageContractParseError(code, message);
}
