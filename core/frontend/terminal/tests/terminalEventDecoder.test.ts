import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  decodeTerminalEvent,
  MAX_EXACT_JSON_INTEGER,
  TERMINAL_EVENT_TAGS,
  TerminalEventDecodeError,
} from "../terminalEventDecoder.ts";

interface FieldContract {
  jsonType: string;
  nullable: boolean;
}

interface Contract {
  tagField: string;
  maxExactInteger: number;
  variants: { tag: string; fields: Record<string, FieldContract> }[];
}

const contract: Contract = JSON.parse(
  readFileSync(new URL("../terminalEventContract.json", import.meta.url), "utf8"),
);

/** Build a payload that satisfies the contract's declared shape for one tag. */
function sample(tag: string): Record<string, unknown> {
  const variant = contract.variants.find((entry) => entry.tag === tag);
  assert.ok(variant, `contract has no variant "${tag}"`);
  const payload: Record<string, unknown> = { [contract.tagField]: tag };
  for (const [field, shape] of Object.entries(variant.fields)) {
    payload[field] = valueFor(field, shape);
  }
  return payload;
}

function valueFor(field: string, shape: FieldContract): unknown {
  switch (shape.jsonType) {
    case "number":
      return 1;
    case "string":
      return "reason";
    case "array":
      return [0, 27];
    case "object":
      return field === "replay" ? { revision: 1, columns: 80, rows: 24, bytes: [27] } : {};
    default:
      throw new Error(`contract uses an unhandled json type: ${shape.jsonType}`);
  }
}

test("the decoder covers exactly the variants the host declares", () => {
  const declared = contract.variants.map((variant) => variant.tag).sort();
  assert.deepEqual([...TERMINAL_EVENT_TAGS].sort(), declared);
});

test("the decoder and the host agree on the exact integer boundary", () => {
  assert.equal(MAX_EXACT_JSON_INTEGER, contract.maxExactInteger);
  assert.equal(MAX_EXACT_JSON_INTEGER, Number.MAX_SAFE_INTEGER);
});

test("every declared variant decodes", () => {
  for (const variant of contract.variants) {
    const decoded = decodeTerminalEvent(sample(variant.tag));
    assert.equal(decoded.event, variant.tag);
    assert.equal(decoded.sequence, 1);
  }
});

test("a variant the host has not declared is rejected, not ignored", () => {
  assert.throws(
    () => decodeTerminalEvent({ event: "semantic_frame", sequence: 1 }),
    TerminalEventDecodeError,
  );
});

test("a required field missing from any variant is rejected", () => {
  for (const variant of contract.variants) {
    for (const field of Object.keys(variant.fields)) {
      const payload = sample(variant.tag);
      delete payload[field];
      assert.throws(
        () => decodeTerminalEvent(payload),
        TerminalEventDecodeError,
        `${variant.tag}.${field} may not be optional`,
      );
    }
  }
});

test("a field of the wrong type in any variant is rejected", () => {
  for (const variant of contract.variants) {
    for (const [field, shape] of Object.entries(variant.fields)) {
      const payload = sample(variant.tag);
      payload[field] = shape.jsonType === "string" ? 1 : "not-the-declared-type";
      assert.throws(
        () => decodeTerminalEvent(payload),
        TerminalEventDecodeError,
        `${variant.tag}.${field} accepted the wrong type`,
      );
    }
  }
});

test("a sequence outside the exact integer range is rejected", () => {
  for (const bad of [0, -1, 1.5, MAX_EXACT_JSON_INTEGER + 2, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => decodeTerminalEvent({ ...sample("detached"), sequence: bad }),
      TerminalEventDecodeError,
      `sequence ${bad} was accepted`,
    );
  }
});

test("a nested replay field is validated, not trusted", () => {
  const payload = sample("replay");
  payload.replay = { revision: 1, columns: 80, rows: 24, bytes: [300] };
  assert.throws(() => decodeTerminalEvent(payload), TerminalEventDecodeError);
});

test("a non-object payload is rejected", () => {
  for (const bad of [null, 7, "output", [{ event: "output" }]]) {
    assert.throws(() => decodeTerminalEvent(bad), TerminalEventDecodeError);
  }
});
