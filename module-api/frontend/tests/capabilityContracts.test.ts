import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CAPABILITY_DIAGNOSTIC_CODES,
  CapabilityContractParseError,
  parseCapabilityManifest,
} from "../src/protocol/capabilities.ts";
import { JSON_SCHEMA_DRAFT_2020_12 } from "../src/protocol/messages.ts";

const DEFINITION_DIGEST = "a".repeat(64);
const REQUEST_ID = "fixture.work-review.request";
const RESPONSE_ID = "fixture.work-review.response";
const EVENT_ID = "fixture.work-review.completed";
const STREAM_ID = "fixture.work-review.output";
const PORT_ID = "fixture.work-review.review";
const TOPIC_ID = "fixture.work-review.completed-topic";

function messageContract(id: string, path: string): unknown {
  return {
    message: { id, version: 1 },
    schema: {
      draft: JSON_SCHEMA_DRAFT_2020_12,
      root: path,
      resources: {
        [path]: {
          $schema: JSON_SCHEMA_DRAFT_2020_12,
          $id: `shipctl-artifact:///${path}`,
          type: "object",
        },
      },
      maxEncodedBytes: 1024,
      redactedFields: [],
      compatibleVersions: [1],
    },
  };
}

function validManifest(): Record<string, unknown> {
  const capability = {
    id: "fixture.work-review",
    version: "1.2.3",
    definitionDigestSha256: DEFINITION_DIGEST,
  };
  return {
    schemaVersion: 1,
    definitions: [
      {
        ...capability,
        schemas: [
          messageContract(REQUEST_ID, "messages/work-review-request.schema.json"),
          messageContract(RESPONSE_ID, "messages/work-review-response.schema.json"),
          messageContract(EVENT_ID, "messages/work-review-completed.schema.json"),
          messageContract(STREAM_ID, "messages/work-review-output.schema.json"),
        ],
        ports: [
          {
            id: PORT_ID,
            kind: "command",
            request: { id: REQUEST_ID, version: 1 },
            response: { id: RESPONSE_ID, version: 1 },
          },
        ],
        events: [{ id: EVENT_ID, message: { id: EVENT_ID, version: 1 } }],
        topics: [
          {
            id: TOPIC_ID,
            eventId: EVENT_ID,
            message: { id: EVENT_ID, version: 1 },
          },
        ],
        streams: [{ id: STREAM_ID, message: { id: STREAM_ID, version: 1 }, ordered: true }],
        providerCardinality: "exclusive",
        selection: "priority",
        scopes: ["instance", "workspace"],
        agentAccess: {
          inspect: true,
          invoke: [PORT_ID],
          watch: { events: [EVENT_ID], topics: [TOPIC_ID] },
          attach: [STREAM_ID],
        },
      },
    ],
    providers: [
      {
        capability,
        surfaces: {
          ports: [PORT_ID],
          events: [EVENT_ID],
          topics: [TOPIC_ID],
          streams: [STREAM_ID],
        },
        scopes: ["instance"],
        priority: 100,
      },
    ],
    consumers: [
      {
        capability,
        surfaces: {
          ports: [PORT_ID],
          events: [EVENT_ID],
          topics: [TOPIC_ID],
          streams: [STREAM_ID],
        },
        scopes: ["workspace"],
      },
    ],
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("capability metadata parser preserves a host-admitted digest after structural validation", () => {
  const manifest = validManifest();
  assert.deepEqual(parseCapabilityManifest(manifest), manifest);
});

test("capability metadata parser accepts only the digest wire shape; artifact admission owns digest verification", () => {
  const malformed = clone(validManifest());
  const definition = malformed.definitions as Record<string, unknown>[];
  definition[0]!.definitionDigestSha256 = "not-a-sha256-digest";
  assert.throws(
    () => parseCapabilityManifest(malformed),
    (error: unknown) =>
      error instanceof CapabilityContractParseError &&
      error.code === CAPABILITY_DIAGNOSTIC_CODES.invalidDigest,
  );

  const hostAdmitted = clone(validManifest());
  const hostDefinition = hostAdmitted.definitions as Record<string, unknown>[];
  hostDefinition[0]!.definitionDigestSha256 = "c".repeat(64);
  const providers = hostAdmitted.providers as Record<string, unknown>[];
  const providerCapability = providers[0]!.capability as Record<string, unknown>;
  providerCapability.definitionDigestSha256 = "c".repeat(64);
  const consumers = hostAdmitted.consumers as Record<string, unknown>[];
  const consumerCapability = consumers[0]!.capability as Record<string, unknown>;
  consumerCapability.definitionDigestSha256 = "c".repeat(64);
  assert.deepEqual(parseCapabilityManifest(hostAdmitted), hostAdmitted);
});

test("capability metadata rejects undeclared agent surfaces and incompatible bindings", () => {
  const agentAccess = clone(validManifest());
  const definitions = agentAccess.definitions as Record<string, unknown>[];
  const access = definitions[0]?.agentAccess as Record<string, unknown>;
  access.invoke = ["fixture.work-review.hidden"];
  assert.throws(
    () => parseCapabilityManifest(agentAccess),
    (error: unknown) =>
      error instanceof CapabilityContractParseError &&
      error.code === CAPABILITY_DIAGNOSTIC_CODES.invalidAgentAccess,
  );

  const incompatibleBinding = clone(validManifest());
  const providers = incompatibleBinding.providers as Record<string, unknown>[];
  const capability = providers[0]?.capability as Record<string, unknown>;
  capability.definitionDigestSha256 = "b".repeat(64);
  assert.throws(
    () => parseCapabilityManifest(incompatibleBinding),
    (error: unknown) =>
      error instanceof CapabilityContractParseError &&
      error.code === CAPABILITY_DIAGNOSTIC_CODES.incompatibleBinding,
  );
});

test("capability metadata rejects unknown fields and semantically invalid selection", () => {
  const unknownField = clone(validManifest());
  unknownField.activatedProvider = "forged";
  assert.throws(
    () => parseCapabilityManifest(unknownField),
    (error: unknown) =>
      error instanceof CapabilityContractParseError &&
      error.code === CAPABILITY_DIAGNOSTIC_CODES.unknownField,
  );

  const invalidSelection = clone(validManifest());
  const definitions = invalidSelection.definitions as Record<string, unknown>[];
  definitions[0]!.selection = "all";
  assert.throws(
    () => parseCapabilityManifest(invalidSelection),
    (error: unknown) =>
      error instanceof CapabilityContractParseError &&
      error.code === CAPABILITY_DIAGNOSTIC_CODES.invalidSelection,
  );
});

test("capability bindings can target a supplied offline catalog without redefining it", () => {
  const parsed = parseCapabilityManifest(validManifest());
  const externalBinding = clone(validManifest());
  externalBinding.definitions = [];
  assert.deepEqual(
    parseCapabilityManifest(externalBinding, parsed.definitions),
    externalBinding,
  );
});

test("the capability API contains declaration parsing only, not activation behavior", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/protocol/capabilities.ts", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(source, /@tauri-apps|@shipctl\/core/);
  assert.doesNotMatch(source, /RuntimeMessageBus|activate\s*\(/);
  assert.doesNotMatch(source, /node:crypto|createHash/);
  assert.match(source, /function parseCapabilityManifest/);
});
