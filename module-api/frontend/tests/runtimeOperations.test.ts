import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  RUNTIME_OPERATION_DIAGNOSTIC_CODES,
  RUNTIME_OPERATION_SCHEMA_VERSION,
  RuntimeOperationParseError,
  parseRuntimeOperationRequest,
  parseRuntimeOperationResponse,
  runtimeOperationFailure,
  runtimeOperationUnavailable,
} from "../src/protocol/runtimeOperations.ts";

test("runtime operation requests preserve one strict workspace/configuration envelope", () => {
  const workspace = {
    schemaVersion: RUNTIME_OPERATION_SCHEMA_VERSION,
    operation: "workspace.plan",
    workspaceId: "shipctl.workspace.default",
    command: {
      kind: "reset",
      expectedRevision: 1,
      originId: "fixture",
    },
  } as const;
  const configuration = {
    schemaVersion: RUNTIME_OPERATION_SCHEMA_VERSION,
    operation: "configuration.update",
    key: "editor",
    value: { wordWrap: true },
  } as const;

  assert.deepEqual(parseRuntimeOperationRequest(workspace), workspace);
  assert.deepEqual(parseRuntimeOperationRequest(configuration), configuration);
});

test("runtime operation requests reject malformed or policy-shaped envelopes", () => {
  assert.throws(
    () => parseRuntimeOperationRequest({
      schemaVersion: RUNTIME_OPERATION_SCHEMA_VERSION,
      operation: "workspace.inspect",
      workspaceId: "shipctl.workspace.default",
      includeDocument: false,
      hostOnly: true,
    }),
    (error: unknown) => error instanceof RuntimeOperationParseError
      && error.code === RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidRequest,
  );

  assert.throws(
    () => parseRuntimeOperationRequest({
      schemaVersion: RUNTIME_OPERATION_SCHEMA_VERSION,
      operation: "configuration.inspect",
      key: "unbounded-host-setting",
    }),
    (error: unknown) => error instanceof RuntimeOperationParseError
      && error.code === RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidRequest,
  );
});

test("runtime operation responses distinguish semantic failure from offline unavailability", () => {
  const failure = runtimeOperationFailure(
    "workspace.apply",
    "workspace.conflict",
    "Workspace revision does not match.",
    { expectedRevision: 3, actualRevision: 4 },
  );
  const unavailable = runtimeOperationUnavailable(
    "configuration.resolve",
    "Configuration resolution requires a live runtime.",
  );

  assert.deepEqual(parseRuntimeOperationResponse(failure), failure);
  assert.deepEqual(parseRuntimeOperationResponse(unavailable), unavailable);
  assert.throws(
    () => parseRuntimeOperationResponse({
      ...unavailable,
      code: "runtime.operation.no-op",
    }),
    (error: unknown) => error instanceof RuntimeOperationParseError
      && error.code === RUNTIME_OPERATION_DIAGNOSTIC_CODES.invalidResponse,
  );
});

test("runtime operation contract contains data validation only", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/protocol/runtimeOperations.ts", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(source, /@tauri-apps|@shipctl\/core/);
  assert.doesNotMatch(source, /CapabilityInvocation|activate\s*\(/);
  assert.match(source, /parseRuntimeOperationRequest/);
  assert.match(source, /parseRuntimeOperationResponse/);
});
