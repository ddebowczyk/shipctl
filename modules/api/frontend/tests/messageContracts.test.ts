import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  MESSAGE_DIAGNOSTIC_CODES,
  MessageContractParseError,
  parseDeliveryReceipt,
  parseMessageDeclarations,
  parseMessageEnvelope,
  parseMessageObservation,
  parseMessageRouteSnapshot,
  parsePublishReceipt,
} from "../src/messages.ts";

interface GoldenFixture {
  readonly schemaVersion: number;
  readonly valid: {
    readonly declarations: unknown;
    readonly envelope: unknown;
    readonly deliveryReceipt: unknown;
    readonly publishReceipt: unknown;
    readonly routeSnapshot: unknown;
    readonly observation: unknown;
  };
  readonly invalid: readonly {
    readonly name: string;
    readonly target: "declarations" | "envelope" | "observation" | "payload" | "authorization";
    readonly value: unknown;
    readonly expectedCode: string;
  }[];
}

const fixturePath = fileURLToPath(
  new URL("../../fixtures/message-contracts.json", import.meta.url),
);
const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as GoldenFixture;

test("TypeScript consumes the exact shared valid message wire goldens", () => {
  assert.deepEqual(parseMessageDeclarations(fixtures.valid.declarations), fixtures.valid.declarations);
  assert.deepEqual(parseMessageEnvelope(fixtures.valid.envelope), fixtures.valid.envelope);
  assert.deepEqual(parseDeliveryReceipt(fixtures.valid.deliveryReceipt), fixtures.valid.deliveryReceipt);
  assert.deepEqual(parsePublishReceipt(fixtures.valid.publishReceipt), fixtures.valid.publishReceipt);
  assert.deepEqual(parseMessageRouteSnapshot(fixtures.valid.routeSnapshot), fixtures.valid.routeSnapshot);
  assert.deepEqual(parseMessageObservation(fixtures.valid.observation), fixtures.valid.observation);
});

test("TypeScript rejects every shared invalid wire shape at its boundary", () => {
  for (const fixture of fixtures.invalid) {
    if (fixture.target === "payload") {
      const envelope = parseMessageEnvelope(fixture.value);
      assert.equal(typeof envelope.payload, "object", fixture.name);
      assert.ok(
        Object.values(MESSAGE_DIAGNOSTIC_CODES).includes(
          fixture.expectedCode as (typeof MESSAGE_DIAGNOSTIC_CODES)[keyof typeof MESSAGE_DIAGNOSTIC_CODES],
        ),
        fixture.name,
      );
      continue;
    }
    if (fixture.target === "authorization") {
      assert.equal(fixture.expectedCode, MESSAGE_DIAGNOSTIC_CODES.unauthorizedSender);
      continue;
    }
    const parse = {
      declarations: parseMessageDeclarations,
      envelope: parseMessageEnvelope,
      observation: parseMessageObservation,
    }[fixture.target];
    assert.throws(
      () => parse(fixture.value),
      (error: unknown) =>
        error instanceof MessageContractParseError && error.code === fixture.expectedCode,
      fixture.name,
    );
  }
});

test("the module message API is pure and carries no caller identity authority", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/messages.ts", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(source, /@tauri-apps|moduleId/);
  assert.match(source, /send<Payload>\(\s*channel:/);
  assert.match(source, /publish<Payload>\(\s*topic:/);
});
