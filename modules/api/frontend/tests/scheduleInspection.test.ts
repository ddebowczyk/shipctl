import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  SCHEDULE_DIAGNOSTIC_CODES,
  ScheduleInspectionParseError,
  parseScheduleInspection,
} from "../src/schedules.ts";

interface GoldenFixture {
  readonly schemaVersion: number;
  readonly valid: unknown;
}

const fixturePath = fileURLToPath(
  new URL("../../fixtures/schedule-inspection.json", import.meta.url),
);
const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as GoldenFixture;

test("TypeScript consumes the exact normalized scheduler inspection golden", () => {
  assert.equal(fixtures.schemaVersion, 1);
  assert.deepEqual(parseScheduleInspection(fixtures.valid), fixtures.valid);
});

test("TypeScript rejects unknown and unsafe scheduler inspection data", () => {
  const golden = fixtures.valid as Record<string, unknown>;
  assert.throws(
    () => parseScheduleInspection({ ...golden, forgedAuthority: true }),
    (error: unknown) =>
      error instanceof ScheduleInspectionParseError &&
      error.code === SCHEDULE_DIAGNOSTIC_CODES.sourceUnknownField,
  );

  const schedules = golden.schedules as readonly Record<string, unknown>[];
  assert.throws(
    () =>
      parseScheduleInspection({
        ...golden,
        schedules: [{ ...schedules[0], sourcePath: "../outside.yaml" }, ...schedules.slice(1)],
      }),
    (error: unknown) =>
      error instanceof ScheduleInspectionParseError &&
      error.code === SCHEDULE_DIAGNOSTIC_CODES.sourcePathUnsafe,
  );
});

test("TypeScript accepts only stable redacted scheduler diagnostics", () => {
  const golden = fixtures.valid as Record<string, unknown>;
  const diagnostic = {
    schemaVersion: 1,
    code: SCHEDULE_DIAGNOSTIC_CODES.targetUnavailable,
    severity: "warning",
    sourcePath: "valid-channel.yaml",
    scheduleId: "agents.wakeup",
    context: { fields: { endpoint: "agents.wakeup", apiToken: "[redacted]" } },
  };
  assert.deepEqual(
    parseScheduleInspection({ ...golden, diagnostics: [diagnostic] }).diagnostics,
    [diagnostic],
  );
  const secretPayloadDiagnostic = {
    ...diagnostic,
    code: SCHEDULE_DIAGNOSTIC_CODES.secretPayloadForbidden,
    context: {},
  };
  assert.deepEqual(
    parseScheduleInspection({ ...golden, diagnostics: [secretPayloadDiagnostic] }).diagnostics,
    [secretPayloadDiagnostic],
  );
  assert.throws(
    () => parseScheduleInspection({ ...golden, diagnostics: [{ ...diagnostic, code: "scheduler.new" }] }),
    (error: unknown) =>
      error instanceof ScheduleInspectionParseError &&
      error.code === SCHEDULE_DIAGNOSTIC_CODES.sourceInvalid,
  );
  assert.throws(
    () =>
      parseScheduleInspection({
        ...golden,
        diagnostics: [{ ...diagnostic, context: { fields: { apiToken: "forged" } } }],
      }),
    (error: unknown) =>
      error instanceof ScheduleInspectionParseError &&
      error.code === SCHEDULE_DIAGNOSTIC_CODES.diagnosticSecretLeakage,
  );
});

test("the scheduler inspection API is a normalized wire consumer only", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/schedules.ts", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(source, /^\s*import(?:\s+type)?\s+.*\bya?ml\b/im);
  assert.doesNotMatch(source, /@tauri-apps/);
});
