import {
  MESSAGE_CONTRACT_SCHEMA_VERSION,
  MessageContractParseError,
  parseMessageDeclarations,
} from "./messages.ts";
import type {
  BroadcastTopic,
  CapabilityPort,
  MessageTypeContract,
  MessageTypeId,
} from "./messages.ts";

/** The stable wire version for offline capability metadata. */
export const CAPABILITY_CONTRACT_SCHEMA_VERSION = 1 as const;

export const CAPABILITY_DIAGNOSTIC_CODES = {
  schemaVersionUnsupported: "capability.contract.schema_version_unsupported",
  unknownField: "capability.contract.unknown_field",
  invalidJson: "capability.contract.invalid_json",
  invalidIdentifier: "capability.contract.identifier.invalid",
  invalidVersion: "capability.contract.version.invalid",
  invalidDigest: "capability.contract.digest.invalid",
  invalidSchema: "capability.contract.schema.invalid",
  duplicateDefinition: "capability.contract.definition.duplicate",
  conflictingDefinition: "capability.contract.definition.conflict",
  duplicateSurface: "capability.contract.surface.duplicate",
  surfaceRequired: "capability.contract.surface.required",
  unknownSchema: "capability.contract.schema.unknown",
  unknownCapability: "capability.contract.capability.unknown",
  incompatibleBinding: "capability.contract.binding.incompatible",
  duplicateBinding: "capability.contract.binding.duplicate",
  invalidCardinality: "capability.contract.provider_cardinality.invalid",
  invalidSelection: "capability.contract.provider_selection.invalid",
  invalidScope: "capability.contract.scope.invalid",
  invalidAgentAccess: "capability.contract.agent_access.invalid",
} as const;

export type CapabilityDiagnosticCode =
  (typeof CAPABILITY_DIAGNOSTIC_CODES)[keyof typeof CAPABILITY_DIAGNOSTIC_CODES];

export type CapabilityScope = "instance" | "workspace" | "global";
export type CapabilityProviderCardinality = "exclusive" | "multiple";
export type CapabilityProviderSelection = "priority" | "all";
export type CapabilityPortKind = "command" | "query";

/**
 * A host-admitted, content-pinned reference to one semantic capability
 * definition.
 *
 * Bindings pin the digest as well as the ID and semantic version so rendered
 * metadata cannot silently bind to a different definition carrying the same
 * version label. This browser parser checks the digest's wire shape and pin
 * consistency only; Rust offline artifact admission verifies the artifact
 * integrity index and recomputes the definition self-digest.
 */
export interface CapabilityReference {
  readonly id: string;
  readonly version: string;
  readonly definitionDigestSha256: string;
}

/** A typed command or query surface, using the existing request/response port primitive. */
export interface CapabilityPortDefinition extends CapabilityPort<unknown, unknown> {
  readonly kind: CapabilityPortKind;
}

/** A typed event emitted by the capability. */
export interface CapabilityEventDefinition {
  readonly id: string;
  readonly message: MessageTypeId;
}

/**
 * A typed, observable event topic. `eventId` keeps the event semantic and
 * its delivery endpoint distinct while requiring both to share one schema.
 */
export interface CapabilityTopicDefinition extends BroadcastTopic<unknown> {
  readonly eventId: string;
}

/** A dedicated continuous-data surface, outside the general message bus. */
export interface CapabilityStreamDefinition {
  readonly id: string;
  readonly message: MessageTypeId;
  readonly ordered: boolean;
}

/** The named surfaces a provider implements or a consumer requires. */
export interface CapabilitySurfaceBinding {
  readonly ports: readonly string[];
  readonly events: readonly string[];
  readonly topics: readonly string[];
  readonly streams: readonly string[];
}

/** Explicit external-agent watch access, separated by semantic surface kind. */
export interface CapabilityAgentWatchAccess {
  readonly events: readonly string[];
  readonly topics: readonly string[];
}

/**
 * The only agent-visible capability surfaces. This declares metadata only;
 * Phase 5 owns discovery, authorization, invocation, watching, and attach.
 */
export interface CapabilityAgentAccess {
  readonly inspect: boolean;
  readonly invoke: readonly string[];
  readonly watch: CapabilityAgentWatchAccess;
  readonly attach: readonly string[];
}

/**
 * A semantic API that modules may define dynamically. Schemas are the existing
 * versioned message contracts so command, query, event, topic, and stream
 * payloads remain schema-addressable at the artifact boundary.
 */
export interface CapabilityDefinition extends CapabilityReference {
  readonly schemas: readonly MessageTypeContract<unknown>[];
  readonly ports: readonly CapabilityPortDefinition[];
  readonly events: readonly CapabilityEventDefinition[];
  readonly topics: readonly CapabilityTopicDefinition[];
  readonly streams: readonly CapabilityStreamDefinition[];
  readonly providerCardinality: CapabilityProviderCardinality;
  readonly selection: CapabilityProviderSelection;
  readonly scopes: readonly CapabilityScope[];
  readonly agentAccess: CapabilityAgentAccess;
}

/** A module-local provider declaration for a pinned capability definition. */
export interface CapabilityProviderBinding {
  readonly capability: CapabilityReference;
  readonly surfaces: CapabilitySurfaceBinding;
  readonly scopes: readonly CapabilityScope[];
  /** Required when the definition selects a provider by priority. */
  readonly priority?: number;
}

/** A module-local consumer declaration for a pinned capability definition. */
export interface CapabilityConsumerBinding {
  readonly capability: CapabilityReference;
  readonly surfaces: CapabilitySurfaceBinding;
  readonly scopes: readonly CapabilityScope[];
}

/**
 * The `capabilities` portion of an immutable runtime artifact manifest.
 *
 * It deliberately contains no activation identity, route, runtime handle, or
 * code-loading instruction. It can therefore be parsed and validated while
 * the artifact remains disabled.
 */
export interface CapabilityManifest {
  readonly schemaVersion: typeof CAPABILITY_CONTRACT_SCHEMA_VERSION;
  readonly definitions: readonly CapabilityDefinition[];
  readonly providers: readonly CapabilityProviderBinding[];
  readonly consumers: readonly CapabilityConsumerBinding[];
}

export class CapabilityContractParseError extends Error {
  readonly code: CapabilityDiagnosticCode;

  constructor(code: CapabilityDiagnosticCode, message: string) {
    super(message);
    this.name = "CapabilityContractParseError";
    this.code = code;
  }
}

/**
 * Strictly parses data-only, host-admitted capability metadata for frontend
 * inspection.
 *
 * `knownDefinitions` is an offline catalog supplied by the caller, such as
 * built-in host contracts or already-installed artifact definitions. It makes
 * provider and consumer pin validation exact without loading any module code.
 * It is not artifact admission: the Rust repository boundary verifies raw
 * archive integrity and each definition's self-digest before this metadata is
 * exposed to a frontend.
 */
export function parseCapabilityManifest(
  value: unknown,
  knownDefinitions: readonly CapabilityDefinition[] = [],
): CapabilityManifest {
  const object = strictObject(value, ["schemaVersion", "definitions", "providers", "consumers"]);
  requireSchemaVersion(object.schemaVersion);

  const definitions = array(object.definitions).map(parseCapabilityDefinition);
  indexDefinitions(definitions);
  const catalog = indexDefinitions(knownDefinitions);
  for (const definition of definitions) {
    const key = definitionKey(definition);
    const known = catalog.get(key);
    if (known !== undefined && known.definitionDigestSha256 !== definition.definitionDigestSha256) {
      fail(
        CAPABILITY_DIAGNOSTIC_CODES.conflictingDefinition,
        `capability ${definition.id}@${definition.version} conflicts with the available catalog`,
      );
    }
    if (known === undefined) catalog.set(key, definition);
  }

  const providers = array(object.providers).map(parseCapabilityProviderBinding);
  const consumers = array(object.consumers).map(parseCapabilityConsumerBinding);
  assertUniqueBindings(providers, "provider");
  assertUniqueBindings(consumers, "consumer");
  for (const binding of providers) validateProviderBinding(binding, catalog);
  for (const binding of consumers) validateConsumerBinding(binding, catalog);

  return {
    schemaVersion: CAPABILITY_CONTRACT_SCHEMA_VERSION,
    definitions,
    providers,
    consumers,
  };
}

function parseCapabilityDefinition(value: unknown): CapabilityDefinition {
  const object = strictObject(value, [
    "id",
    "version",
    "definitionDigestSha256",
    "schemas",
    "ports",
    "events",
    "topics",
    "streams",
    "providerCardinality",
    "selection",
    "scopes",
    "agentAccess",
  ]);
  const reference = parseCapabilityReferenceFields(
    object.id,
    object.version,
    object.definitionDigestSha256,
  );
  const schemas = parseMessageTypeContracts(object.schemas);
  const schemaTypes = indexMessageTypes(schemas.map(({ message }) => message));
  const ports = array(object.ports).map(parseCapabilityPortDefinition);
  const events = array(object.events).map(parseCapabilityEventDefinition);
  const topics = array(object.topics).map(parseCapabilityTopicDefinition);
  const streams = array(object.streams).map(parseCapabilityStreamDefinition);
  const providerCardinality = parseProviderCardinality(object.providerCardinality);
  const selection = parseProviderSelection(object.selection);
  const scopes = parseScopes(object.scopes);

  assertUniqueStrings(ports.map(({ id }) => id), CAPABILITY_DIAGNOSTIC_CODES.duplicateSurface, "port");
  assertUniqueStrings(events.map(({ id }) => id), CAPABILITY_DIAGNOSTIC_CODES.duplicateSurface, "event");
  assertUniqueStrings(topics.map(({ id }) => id), CAPABILITY_DIAGNOSTIC_CODES.duplicateSurface, "topic");
  assertUniqueStrings(streams.map(({ id }) => id), CAPABILITY_DIAGNOSTIC_CODES.duplicateSurface, "stream");
  if (ports.length + events.length + topics.length + streams.length === 0) {
    fail(CAPABILITY_DIAGNOSTIC_CODES.surfaceRequired, "capability definitions require a surface");
  }
  if (providerCardinality === "exclusive" && selection !== "priority") {
    fail(
      CAPABILITY_DIAGNOSTIC_CODES.invalidSelection,
      "exclusive capabilities must select their sole provider by priority",
    );
  }

  for (const port of ports) {
    assertKnownMessage(port.request, schemaTypes, `port ${port.id} request`);
    assertKnownMessage(port.response, schemaTypes, `port ${port.id} response`);
  }
  for (const event of events) assertKnownMessage(event.message, schemaTypes, `event ${event.id}`);
  const eventById = new Map(events.map((event) => [event.id, event]));
  for (const topic of topics) {
    assertKnownMessage(topic.message, schemaTypes, `topic ${topic.id}`);
    const event = eventById.get(topic.eventId);
    if (event === undefined || !sameMessageType(event.message, topic.message)) {
      fail(
        CAPABILITY_DIAGNOSTIC_CODES.incompatibleBinding,
        `topic ${topic.id} must name an event with the same message schema`,
      );
    }
  }
  for (const stream of streams) assertKnownMessage(stream.message, schemaTypes, `stream ${stream.id}`);

  const definition: CapabilityDefinition = {
    ...reference,
    schemas,
    ports,
    events,
    topics,
    streams,
    providerCardinality,
    selection,
    scopes,
    agentAccess: parseAgentAccess(object.agentAccess, ports, events, topics, streams),
  };
  return definition;
}

function parseCapabilityProviderBinding(value: unknown): CapabilityProviderBinding {
  const object = strictObject(value, ["capability", "surfaces", "scopes"], ["priority"]);
  return {
    capability: parseCapabilityReference(object.capability),
    surfaces: parseSurfaceBinding(object.surfaces),
    scopes: parseScopes(object.scopes),
    ...(object.priority === undefined ? {} : { priority: signedInteger(object.priority) }),
  };
}

function parseCapabilityConsumerBinding(value: unknown): CapabilityConsumerBinding {
  const object = strictObject(value, ["capability", "surfaces", "scopes"]);
  return {
    capability: parseCapabilityReference(object.capability),
    surfaces: parseSurfaceBinding(object.surfaces),
    scopes: parseScopes(object.scopes),
  };
}

function parseCapabilityReference(value: unknown): CapabilityReference {
  const object = strictObject(value, ["id", "version", "definitionDigestSha256"]);
  return parseCapabilityReferenceFields(object.id, object.version, object.definitionDigestSha256);
}

function parseCapabilityReferenceFields(
  id: unknown,
  version: unknown,
  definitionDigestSha256: unknown,
): CapabilityReference {
  return {
    id: scopedId(id),
    version: semanticVersion(version),
    definitionDigestSha256: sha256Digest(definitionDigestSha256),
  };
}

function parseMessageTypeContracts(value: unknown): readonly MessageTypeContract<unknown>[] {
  const schemas = array(value);
  try {
    return parseMessageDeclarations({
      schemaVersion: MESSAGE_CONTRACT_SCHEMA_VERSION,
      provides: schemas,
      handles: [],
      publishes: [],
      subscribes: [],
      ports: [],
    }).provides;
  } catch (error) {
    if (error instanceof MessageContractParseError) {
      fail(CAPABILITY_DIAGNOSTIC_CODES.invalidSchema, error.message);
    }
    throw error;
  }
}

function parseCapabilityPortDefinition(value: unknown): CapabilityPortDefinition {
  const object = strictObject(value, ["id", "kind", "request", "response"]);
  return {
    id: scopedId(object.id),
    kind: parsePortKind(object.kind),
    request: parseMessageTypeId(object.request),
    response: parseMessageTypeId(object.response),
  };
}

function parseCapabilityEventDefinition(value: unknown): CapabilityEventDefinition {
  const object = strictObject(value, ["id", "message"]);
  return { id: scopedId(object.id), message: parseMessageTypeId(object.message) };
}

function parseCapabilityTopicDefinition(value: unknown): CapabilityTopicDefinition {
  const object = strictObject(value, ["id", "eventId", "message"]);
  return {
    id: scopedId(object.id),
    eventId: scopedId(object.eventId),
    message: parseMessageTypeId(object.message),
  };
}

function parseCapabilityStreamDefinition(value: unknown): CapabilityStreamDefinition {
  const object = strictObject(value, ["id", "message", "ordered"]);
  return {
    id: scopedId(object.id),
    message: parseMessageTypeId(object.message),
    ordered: boolean(object.ordered),
  };
}

function parseMessageTypeId(value: unknown): MessageTypeId {
  const object = strictObject(value, ["id", "version"]);
  return { id: scopedId(object.id), version: nonzeroUnsignedInteger(object.version) };
}

function parseSurfaceBinding(value: unknown): CapabilitySurfaceBinding {
  const object = strictObject(value, ["ports", "events", "topics", "streams"]);
  const surfaces = {
    ports: parseSurfaceIds(object.ports, "port"),
    events: parseSurfaceIds(object.events, "event"),
    topics: parseSurfaceIds(object.topics, "topic"),
    streams: parseSurfaceIds(object.streams, "stream"),
  };
  if (
    surfaces.ports.length +
      surfaces.events.length +
      surfaces.topics.length +
      surfaces.streams.length ===
    0
  ) {
    fail(CAPABILITY_DIAGNOSTIC_CODES.surfaceRequired, "capability binding requires a surface");
  }
  return surfaces;
}

function parseAgentAccess(
  value: unknown,
  ports: readonly CapabilityPortDefinition[],
  events: readonly CapabilityEventDefinition[],
  topics: readonly CapabilityTopicDefinition[],
  streams: readonly CapabilityStreamDefinition[],
): CapabilityAgentAccess {
  const object = strictObject(value, ["inspect", "invoke", "watch", "attach"]);
  const watch = strictObject(object.watch, ["events", "topics"]);
  const access = {
    inspect: boolean(object.inspect),
    invoke: parseSurfaceIds(object.invoke, "agent-invokable port"),
    watch: {
      events: parseSurfaceIds(watch.events, "agent-watchable event"),
      topics: parseSurfaceIds(watch.topics, "agent-watchable topic"),
    },
    attach: parseSurfaceIds(object.attach, "agent-attachable stream"),
  };
  assertSurfaceSubset(access.invoke, ports.map(({ id }) => id), "agent invoke");
  assertSurfaceSubset(access.watch.events, events.map(({ id }) => id), "agent event watch");
  assertSurfaceSubset(access.watch.topics, topics.map(({ id }) => id), "agent topic watch");
  assertSurfaceSubset(access.attach, streams.map(({ id }) => id), "agent stream attach");
  return access;
}

function parseSurfaceIds(value: unknown, kind: string): readonly string[] {
  const ids = array(value).map(scopedId);
  assertUniqueStrings(ids, CAPABILITY_DIAGNOSTIC_CODES.duplicateSurface, kind);
  return ids;
}

function parseScopes(value: unknown): readonly CapabilityScope[] {
  const scopes = array(value).map(parseScope);
  if (scopes.length === 0) {
    fail(CAPABILITY_DIAGNOSTIC_CODES.invalidScope, "capability scopes cannot be empty");
  }
  assertUniqueStrings(scopes, CAPABILITY_DIAGNOSTIC_CODES.invalidScope, "scope");
  return scopes;
}

function parseScope(value: unknown): CapabilityScope {
  if (value === "instance" || value === "workspace" || value === "global") return value;
  fail(CAPABILITY_DIAGNOSTIC_CODES.invalidScope, "capability scope is invalid");
}

function parsePortKind(value: unknown): CapabilityPortKind {
  if (value === "command" || value === "query") return value;
  fail(CAPABILITY_DIAGNOSTIC_CODES.invalidJson, "capability port kind is invalid");
}

function parseProviderCardinality(value: unknown): CapabilityProviderCardinality {
  if (value === "exclusive" || value === "multiple") return value;
  fail(CAPABILITY_DIAGNOSTIC_CODES.invalidCardinality, "capability provider cardinality is invalid");
}

function parseProviderSelection(value: unknown): CapabilityProviderSelection {
  if (value === "priority" || value === "all") return value;
  fail(CAPABILITY_DIAGNOSTIC_CODES.invalidSelection, "capability provider selection is invalid");
}

function validateProviderBinding(
  binding: CapabilityProviderBinding,
  catalog: ReadonlyMap<string, CapabilityDefinition>,
): void {
  const definition = resolveBindingDefinition(binding.capability, catalog);
  validateBindingSurfaces(binding.surfaces, definition, "provider");
  validateBindingScopes(binding.scopes, definition, "provider");
  if (definition.selection === "priority" && binding.priority === undefined) {
    fail(
      CAPABILITY_DIAGNOSTIC_CODES.invalidSelection,
      `provider ${binding.capability.id}@${binding.capability.version} requires a priority`,
    );
  }
  if (definition.selection === "all" && binding.priority !== undefined) {
    fail(
      CAPABILITY_DIAGNOSTIC_CODES.invalidSelection,
      `provider ${binding.capability.id}@${binding.capability.version} cannot set priority for all selection`,
    );
  }
}

function validateConsumerBinding(
  binding: CapabilityConsumerBinding,
  catalog: ReadonlyMap<string, CapabilityDefinition>,
): void {
  const definition = resolveBindingDefinition(binding.capability, catalog);
  validateBindingSurfaces(binding.surfaces, definition, "consumer");
  validateBindingScopes(binding.scopes, definition, "consumer");
}

function resolveBindingDefinition(
  reference: CapabilityReference,
  catalog: ReadonlyMap<string, CapabilityDefinition>,
): CapabilityDefinition {
  const definition = catalog.get(definitionKey(reference));
  if (definition === undefined) {
    fail(
      CAPABILITY_DIAGNOSTIC_CODES.unknownCapability,
      `capability ${reference.id}@${reference.version} is not defined in the offline catalog`,
    );
  }
  if (definition.definitionDigestSha256 !== reference.definitionDigestSha256) {
    fail(
      CAPABILITY_DIAGNOSTIC_CODES.incompatibleBinding,
      `capability ${reference.id}@${reference.version} does not pin the catalog definition digest`,
    );
  }
  return definition;
}

function validateBindingSurfaces(
  surfaces: CapabilitySurfaceBinding,
  definition: CapabilityDefinition,
  bindingKind: string,
): void {
  assertSurfaceSubset(
    surfaces.ports,
    definition.ports.map(({ id }) => id),
    `${bindingKind} port`,
    CAPABILITY_DIAGNOSTIC_CODES.incompatibleBinding,
  );
  assertSurfaceSubset(
    surfaces.events,
    definition.events.map(({ id }) => id),
    `${bindingKind} event`,
    CAPABILITY_DIAGNOSTIC_CODES.incompatibleBinding,
  );
  assertSurfaceSubset(
    surfaces.topics,
    definition.topics.map(({ id }) => id),
    `${bindingKind} topic`,
    CAPABILITY_DIAGNOSTIC_CODES.incompatibleBinding,
  );
  assertSurfaceSubset(
    surfaces.streams,
    definition.streams.map(({ id }) => id),
    `${bindingKind} stream`,
    CAPABILITY_DIAGNOSTIC_CODES.incompatibleBinding,
  );
}

function validateBindingScopes(
  scopes: readonly CapabilityScope[],
  definition: CapabilityDefinition,
  bindingKind: string,
): void {
  for (const scope of scopes) {
    if (!definition.scopes.includes(scope)) {
      fail(
        CAPABILITY_DIAGNOSTIC_CODES.invalidScope,
        `${bindingKind} binding scope ${scope} is not supported by ${definition.id}`,
      );
    }
  }
}

function assertSurfaceSubset(
  requested: readonly string[],
  available: readonly string[],
  surfaceKind: string,
  code: CapabilityDiagnosticCode = CAPABILITY_DIAGNOSTIC_CODES.invalidAgentAccess,
): void {
  const known = new Set(available);
  for (const id of requested) {
    if (!known.has(id)) {
      fail(code, `${surfaceKind} references undeclared surface ${id}`);
    }
  }
}

function assertKnownMessage(
  message: MessageTypeId,
  knownMessages: ReadonlyMap<string, MessageTypeId>,
  surface: string,
): void {
  if (!knownMessages.has(messageTypeKey(message))) {
    fail(
      CAPABILITY_DIAGNOSTIC_CODES.unknownSchema,
      `${surface} references a message schema not declared by the capability`,
    );
  }
}

function indexMessageTypes(messages: readonly MessageTypeId[]): ReadonlyMap<string, MessageTypeId> {
  const result = new Map<string, MessageTypeId>();
  for (const message of messages) {
    const key = messageTypeKey(message);
    if (result.has(key)) {
      fail(
        CAPABILITY_DIAGNOSTIC_CODES.invalidSchema,
        `message schema ${message.id}@${message.version} is duplicated`,
      );
    }
    result.set(key, message);
  }
  return result;
}

function indexDefinitions(definitions: readonly CapabilityDefinition[]): Map<string, CapabilityDefinition> {
  const result = new Map<string, CapabilityDefinition>();
  for (const definition of definitions) {
    const key = definitionKey(definition);
    const existing = result.get(key);
    if (existing !== undefined) {
      if (existing.definitionDigestSha256 !== definition.definitionDigestSha256) {
        fail(
          CAPABILITY_DIAGNOSTIC_CODES.conflictingDefinition,
          `capability ${definition.id}@${definition.version} has conflicting content`,
        );
      }
      fail(
        CAPABILITY_DIAGNOSTIC_CODES.duplicateDefinition,
        `capability ${definition.id}@${definition.version} is declared more than once`,
      );
    }
    result.set(key, definition);
  }
  return result;
}

function assertUniqueBindings(
  bindings: readonly CapabilityProviderBinding[] | readonly CapabilityConsumerBinding[],
  kind: string,
): void {
  assertUniqueStrings(
    bindings.map(({ capability }) => definitionKey(capability)),
    CAPABILITY_DIAGNOSTIC_CODES.duplicateBinding,
    kind,
  );
}

function assertUniqueStrings(
  values: readonly string[],
  code: CapabilityDiagnosticCode,
  kind: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail(code, `${kind} ${value} is duplicated`);
    seen.add(value);
  }
}

function definitionKey(reference: CapabilityReference): string {
  return `${reference.id}@${reference.version}`;
}

function messageTypeKey(message: MessageTypeId): string {
  return `${message.id}@${message.version}`;
}

function sameMessageType(left: MessageTypeId, right: MessageTypeId): boolean {
  return left.id === right.id && left.version === right.version;
}

function strictObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) fail(CAPABILITY_DIAGNOSTIC_CODES.invalidJson, "expected an object");
  for (const key of required) {
    if (!hasOwn(value, key)) fail(CAPABILITY_DIAGNOSTIC_CODES.invalidJson, `missing ${key}`);
  }
  const accepted = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) {
      fail(CAPABILITY_DIAGNOSTIC_CODES.unknownField, `unknown field ${key}`);
    }
  }
  return value;
}

function requireSchemaVersion(value: unknown): void {
  if (value !== CAPABILITY_CONTRACT_SCHEMA_VERSION) {
    fail(CAPABILITY_DIAGNOSTIC_CODES.schemaVersionUnsupported, "unsupported capability schemaVersion");
  }
}

function scopedId(value: unknown): string {
  const id = nonemptyString(value);
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(id)) {
    fail(CAPABILITY_DIAGNOSTIC_CODES.invalidIdentifier, "invalid scoped identifier");
  }
  return id;
}

function semanticVersion(value: unknown): string {
  const version = nonemptyString(value);
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.test(
      version,
    )
  ) {
    fail(CAPABILITY_DIAGNOSTIC_CODES.invalidVersion, "capability version must be semantic versioning");
  }
  return version;
}

function sha256Digest(value: unknown): string {
  const digest = nonemptyString(value);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    fail(CAPABILITY_DIAGNOSTIC_CODES.invalidDigest, "expected a lowercase SHA-256 digest");
  }
  return digest;
}

function signedInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(CAPABILITY_DIAGNOSTIC_CODES.invalidSelection, "provider priority must be an integer");
  }
  return value;
}

function nonzeroUnsignedInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail(CAPABILITY_DIAGNOSTIC_CODES.invalidJson, "message version must be a non-zero unsigned integer");
  }
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    fail(CAPABILITY_DIAGNOSTIC_CODES.invalidJson, "expected a boolean");
  }
  return value;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) fail(CAPABILITY_DIAGNOSTIC_CODES.invalidJson, "expected an array");
  return value;
}

function nonemptyString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(CAPABILITY_DIAGNOSTIC_CODES.invalidJson, "expected a non-empty string");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fail(code: CapabilityDiagnosticCode, message: string): never {
  throw new CapabilityContractParseError(code, message);
}
