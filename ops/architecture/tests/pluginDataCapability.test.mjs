import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { createServer } from "vite";

let vite;
let createFakePluginDataServiceProvider;
let createPluginDataServiceProvider;
let createTestActivationIdentity;
let pluginDataService;
let SemanticServiceRegistry;
let SemanticServiceTestHost;

function propertyParameters() {
  const configured = process.env.SHIPCTL_PROPERTY_SEED;
  if (configured === undefined) return {};
  const seed = Number(configured);
  if (!Number.isSafeInteger(seed)) {
    throw new Error("SHIPCTL_PROPERTY_SEED must be a safe integer");
  }
  return { seed };
}

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({ pluginDataService } = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ));
  ({
    createFakePluginDataServiceProvider,
    createTestActivationIdentity,
    SemanticServiceTestHost,
  } = await vite.ssrLoadModule("/module-api/frontend/src/testing.ts"));
  ({ createPluginDataServiceProvider } = await vite.ssrLoadModule(
    "/core/frontend/platform/pluginData.ts",
  ));
  ({ SemanticServiceRegistry } = await vite.ssrLoadModule(
    "/core/frontend/runtime/index.ts",
  ));
});

after(async () => {
  await vite?.close();
});

const jsonValueArbitrary = fc.jsonValue();
const keyArbitrary = fc.stringMatching(/^[a-z][a-z0-9-]*$/);
const PLUGIN_DATA_GRANTS = Object.freeze([
  "plugin-data.read",
  "plugin-data.write",
  "plugin-data.migrate",
]);

function acceptedAdmission(moduleId, effectiveGrants = PLUGIN_DATA_GRANTS) {
  const contentDigest = "0".repeat(64);
  return Object.freeze({
    artifact: Object.freeze({
      contentDigest,
      entryUrl: `asset://localhost/${contentDigest}/index.js`,
      moduleId,
      version: "1.0.0",
    }),
    effectiveGrants: Object.freeze([...effectiveGrants]),
  });
}

function recordId(moduleId, scope, key) {
  return JSON.stringify([moduleId, scope, key]);
}

function clone(value) {
  return structuredClone(value);
}

class MemoryPluginDataTransport {
  records = new Map();
  requests = [];

  async read(request) {
    this.requests.push(["read", request]);
    const record = this.records.get(recordId(
      request.activation.moduleId,
      request.input.scope,
      request.input.key,
    ));
    return record ? clone(record) : null;
  }

  async write(request) {
    this.requests.push(["write", request]);
    const id = recordId(
      request.activation.moduleId,
      request.input.scope,
      request.input.key,
    );
    const current = this.records.get(id);
    if (
      (current === undefined && request.input.expectedRevision !== null)
      || (current !== undefined && current.revision !== request.input.expectedRevision)
    ) throw new Error("plugin-data.conflict: stale write");
    const record = {
      ownerModuleId: request.activation.moduleId,
      scope: clone(request.input.scope),
      key: request.input.key,
      schemaVersion: request.input.schemaVersion,
      revision: (current?.revision ?? 0) + 1,
      value: clone(request.input.value),
      migrations: current?.migrations ?? [],
    };
    this.records.set(id, record);
    return clone(record);
  }

  async migrate(request) {
    this.requests.push(["migrate", request]);
    const current = request.input.records.map((write) => {
      const record = this.records.get(recordId(
        request.activation.moduleId,
        write.scope,
        write.key,
      ));
      if (!record) throw new Error("plugin-data.not-found: missing record");
      return record;
    });
    const replayed = current.every((record, index) => {
      const write = request.input.records[index];
      return record.migrations.some((migration) => (
        migration.migrationId === request.input.migrationId
        && migration.fromSchemaVersion === write.fromSchemaVersion
        && migration.toSchemaVersion === write.toSchemaVersion
      ));
    });
    if (replayed) {
      return {
        migrationId: request.input.migrationId,
        records: current.map(clone),
        replayed: true,
      };
    }
    const migrated = current.map((record, index) => {
      const write = request.input.records[index];
      if (
        record.revision !== write.expectedRevision
        || record.schemaVersion !== write.fromSchemaVersion
      ) throw new Error("plugin-data.conflict: stale migration");
      return {
        ownerModuleId: request.activation.moduleId,
        scope: clone(write.scope),
        key: write.key,
        schemaVersion: write.toSchemaVersion,
        revision: record.revision + 1,
        value: clone(write.value),
        migrations: [...record.migrations, {
          migrationId: request.input.migrationId,
          fromSchemaVersion: write.fromSchemaVersion,
          toSchemaVersion: write.toSchemaVersion,
        }],
      };
    });
    for (const record of migrated) {
      this.records.set(recordId(record.ownerModuleId, record.scope, record.key), record);
    }
    return {
      migrationId: request.input.migrationId,
      records: migrated.map(clone),
      replayed: false,
    };
  }
}

function productionActivation({
  moduleId = "shipctl.usage",
  transport = new MemoryPluginDataTransport(),
  grants = PLUGIN_DATA_GRANTS,
} = {}) {
  const registry = new SemanticServiceRegistry([
    createPluginDataServiceProvider({ transport }),
  ]);
  const identity = createTestActivationIdentity(moduleId);
  const admission = acceptedAdmission(moduleId, grants);
  const activation = registry.activate(identity, admission);
  return {
    activation,
    admission,
    identity,
    service: activation.context.services.require(pluginDataService),
    transport,
  };
}

async function result(operation, input) {
  const outcome = await operation.execute(input);
  return outcome.result;
}

test("architecture.service-adapter.plugin-data.property", async () => {
  await fc.assert(fc.asyncProperty(jsonValueArbitrary, async (value) => {
    const fixture = productionActivation();
    const written = await fixture.service.writeRecord.execute({
      scope: { kind: "global" },
      key: "settings",
      expectedRevision: null,
      schemaVersion: 1,
      value,
    });
    assert.equal(written.result.ok, true);
    assert.equal(fixture.transport.requests.length, 1);
    const [, request] = fixture.transport.requests[0];
    assert.deepEqual(request.activation, {
      moduleId: fixture.identity.moduleId,
      activationId: fixture.identity.activationId,
      effectiveGrants: ["plugin-data.read", "plugin-data.write", "plugin-data.migrate"],
    });
    assert.equal(request.correlationId, written.correlationId);
    assert.deepEqual(request.input.value, value);
    await fixture.activation.dispose();
  }), propertyParameters());

  await fc.assert(fc.asyncProperty(
    fc.constantFrom(
      "plugin-data.denied: denied",
      "plugin-data.conflict: stale",
      "unknown command",
      "storage broke",
    ),
    async (failure) => {
      const fixture = productionActivation({
        transport: {
          read: async () => { throw new Error(failure); },
          write: async () => { throw new Error(failure); },
          migrate: async () => { throw new Error(failure); },
        },
      });
      const outcome = await fixture.service.readRecord.execute({
        scope: { kind: "global" },
        key: "settings",
      });
      assert.equal(outcome.result.ok, false);
      assert.equal(
        outcome.result.error.code,
        failure.startsWith("plugin-data.denied")
          ? "plugin-data.denied"
          : failure.startsWith("plugin-data.conflict")
            ? "plugin-data.conflict"
            : failure === "unknown command"
              ? "plugin-data.unavailable"
              : "plugin-data.transport-failed",
      );
      await fixture.activation.dispose();
    },
  ), propertyParameters());

  await fc.assert(fc.asyncProperty(jsonValueArbitrary, async (value) => {
    for (const mutation of ["schema", "revision", "provenance"]) {
      const fixture = productionActivation({
        transport: {
          read: async () => null,
          migrate: async () => { throw new Error("not used"); },
          write: async (request) => ({
            ownerModuleId: request.activation.moduleId,
            scope: clone(request.input.scope),
            key: request.input.key,
            schemaVersion: mutation === "schema" ? 2 : 1,
            revision: mutation === "revision" ? 2 : 1,
            value: clone(request.input.value),
            migrations: mutation === "provenance"
              ? [{
                migrationId: "invalid",
                fromSchemaVersion: 1,
                toSchemaVersion: 1,
              }]
              : [],
          }),
        },
      });
      const outcome = await fixture.service.writeRecord.execute({
        scope: { kind: "global" },
        key: "settings",
        expectedRevision: null,
        schemaVersion: 1,
        value,
      });
      assert.equal(outcome.result.ok, false);
      assert.equal(outcome.result.error.code, "plugin-data.transport-failed");
      await fixture.activation.dispose();
    }
  }), propertyParameters());
});

test("architecture.service-request.plugin-data.property", async () => {
  await fc.assert(fc.asyncProperty(
    fc.stringMatching(/^[a-z][a-z0-9-]*$/),
    keyArbitrary,
    fc.boolean(),
    fc.boolean(),
    async (moduleName, key, admitted, cancelled) => {
      const transport = new MemoryPluginDataTransport();
      const fixture = productionActivation({
        moduleId: `shipctl.${moduleName}`,
        transport,
        grants: admitted ? ["plugin-data.read"] : [],
      });
      const outcome = await fixture.service.readRecord.execute(
        { scope: { kind: "global" }, key },
        { cancellation: { cancelled } },
      );
      assert.equal(outcome.result.ok, admitted && !cancelled);
      assert.equal(transport.requests.length, admitted && !cancelled ? 1 : 0);
      assert.equal(fixture.admission.artifact.moduleId, fixture.identity.moduleId);

      await fixture.activation.dispose();
      const before = transport.requests.length;
      const disposed = await fixture.service.readRecord.execute({
        scope: { kind: "global" },
        key,
      });
      assert.equal(disposed.result.ok, false);
      assert.equal(disposed.result.error.code, "plugin-data.activation-disposed");
      assert.equal(transport.requests.length, before);
    },
  ), propertyParameters());

  await fc.assert(fc.asyncProperty(
    fc.integer({ max: -1 }),
    fc.integer({ max: 0 }),
    async (invalidRevision, invalidSchemaVersion) => {
      const fixture = productionActivation();
      const base = {
        scope: { kind: "global" },
        key: "settings",
        expectedRevision: null,
        schemaVersion: 1,
        value: {},
      };
      const revision = await fixture.service.writeRecord.execute({
        ...base,
        expectedRevision: invalidRevision,
      });
      const schema = await fixture.service.writeRecord.execute({
        ...base,
        schemaVersion: invalidSchemaVersion,
      });
      const value = await fixture.service.writeRecord.execute({
        ...base,
        value: Number.NaN,
      });
      assert.equal(revision.result.ok, false);
      assert.equal(revision.result.error.code, "plugin-data.invalid-revision");
      assert.equal(schema.result.ok, false);
      assert.equal(schema.result.error.code, "plugin-data.invalid-schema");
      assert.equal(value.result.ok, false);
      assert.equal(value.result.error.code, "plugin-data.invalid-value");
      assert.equal(fixture.transport.requests.length, 0);
      await fixture.activation.dispose();
    },
  ), propertyParameters());
});

test("architecture.plugin-data-service-fake.property", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(jsonValueArbitrary, { minLength: 1 }),
    async (values) => {
      const fakeProvider = createFakePluginDataServiceProvider();
      const fakeHost = new SemanticServiceTestHost([fakeProvider]);
      let fakeActivation = fakeHost.activate(
        createTestActivationIdentity("shipctl.usage"),
        acceptedAdmission("shipctl.usage"),
      );
      let fake = fakeActivation.context.services.require(pluginDataService);

      const transport = new MemoryPluginDataTransport();
      let nativeFixture = productionActivation({ transport });
      let native = nativeFixture.service;
      let expectedRevision = null;

      for (const value of values) {
        const input = {
          scope: { kind: "global" },
          key: "settings",
          expectedRevision,
          schemaVersion: 1,
          value,
        };
        const [fakeResult, nativeResult] = await Promise.all([
          result(fake.writeRecord, input),
          result(native.writeRecord, input),
        ]);
        assert.deepEqual(fakeResult, nativeResult);
        assert.equal(fakeResult.ok, true);
        expectedRevision = fakeResult.value.revision;
      }

      const staleInput = {
        scope: { kind: "global" },
        key: "settings",
        expectedRevision: null,
        schemaVersion: 1,
        value: values[0],
      };
      const [fakeConflict, nativeConflict] = await Promise.all([
        result(fake.writeRecord, staleInput),
        result(native.writeRecord, staleInput),
      ]);
      assert.equal(fakeConflict.ok, false);
      assert.equal(nativeConflict.ok, false);
      assert.equal(fakeConflict.error.code, "plugin-data.conflict");
      assert.equal(nativeConflict.error.code, fakeConflict.error.code);

      await Promise.all([fakeActivation.dispose(), nativeFixture.activation.dispose()]);
      fakeActivation = fakeHost.activate(
        createTestActivationIdentity("shipctl.usage"),
        acceptedAdmission("shipctl.usage"),
      );
      fake = fakeActivation.context.services.require(pluginDataService);
      nativeFixture = productionActivation({ transport });
      native = nativeFixture.service;
      const [fakeRead, nativeRead] = await Promise.all([
        result(fake.readRecord, { scope: { kind: "global" }, key: "settings" }),
        result(native.readRecord, { scope: { kind: "global" }, key: "settings" }),
      ]);
      assert.deepEqual(fakeRead, nativeRead);
      await Promise.all([fakeActivation.dispose(), nativeFixture.activation.dispose()]);
    },
  ), propertyParameters());
});

test("architecture.plugin-data-migration.property", async () => {
  await fc.assert(fc.asyncProperty(
    jsonValueArbitrary,
    jsonValueArbitrary,
    jsonValueArbitrary,
    jsonValueArbitrary,
    async (firstValue, secondValue, changedValue, migratedValue) => {
      const host = new SemanticServiceTestHost([
        createFakePluginDataServiceProvider(),
      ]);
      const fakeActivation = host.activate(
        createTestActivationIdentity("shipctl.fixture"),
        acceptedAdmission("shipctl.fixture"),
      );
      const fake = fakeActivation.context.services.require(pluginDataService);
      const nativeFixture = productionActivation({
        moduleId: "shipctl.fixture",
        grants: PLUGIN_DATA_GRANTS,
      });
      const native = nativeFixture.service;

      for (const [key, value] of [["first", firstValue], ["second", secondValue]]) {
        const input = {
          scope: { kind: "global" },
          key,
          expectedRevision: null,
          schemaVersion: 1,
          value,
        };
        const [fakeCreated, nativeCreated] = await Promise.all([
          result(fake.writeRecord, input),
          result(native.writeRecord, input),
        ]);
        assert.deepEqual(fakeCreated, nativeCreated);
        assert.equal(fakeCreated.ok, true);
      }

      const changedInput = {
        scope: { kind: "global" },
        key: "first",
        expectedRevision: 1,
        schemaVersion: 1,
        value: changedValue,
      };
      await Promise.all([
        result(fake.writeRecord, changedInput),
        result(native.writeRecord, changedInput),
      ]);

      const staleTransaction = {
        migrationId: "fixture-v2",
        records: [
          {
            scope: { kind: "global" },
            key: "first",
            expectedRevision: 1,
            fromSchemaVersion: 1,
            toSchemaVersion: 2,
            value: migratedValue,
          },
          {
            scope: { kind: "global" },
            key: "second",
            expectedRevision: 1,
            fromSchemaVersion: 1,
            toSchemaVersion: 2,
            value: migratedValue,
          },
        ],
      };
      const [fakeConflict, nativeConflict] = await Promise.all([
        result(fake.migrateRecords, staleTransaction),
        result(native.migrateRecords, staleTransaction),
      ]);
      assert.equal(fakeConflict.ok, false);
      assert.equal(nativeConflict.ok, false);
      assert.equal(fakeConflict.error.code, "plugin-data.conflict");
      assert.equal(nativeConflict.error.code, fakeConflict.error.code);

      const secondAfterConflict = await Promise.all([
        result(fake.readRecord, { scope: { kind: "global" }, key: "second" }),
        result(native.readRecord, { scope: { kind: "global" }, key: "second" }),
      ]);
      assert.deepEqual(secondAfterConflict[0], secondAfterConflict[1]);
      assert.equal(secondAfterConflict[0].value.schemaVersion, 1);
      assert.equal(secondAfterConflict[0].value.revision, 1);

      const transaction = {
        ...staleTransaction,
        records: [
          { ...staleTransaction.records[0], expectedRevision: 2 },
          staleTransaction.records[1],
        ],
      };
      const [fakeApplied, nativeApplied] = await Promise.all([
        result(fake.migrateRecords, transaction),
        result(native.migrateRecords, transaction),
      ]);
      assert.deepEqual(fakeApplied, nativeApplied);
      assert.equal(fakeApplied.ok, true);
      assert.equal(fakeApplied.value.replayed, false);
      assert.equal(fakeApplied.value.records.length, 2);
      assert.ok(fakeApplied.value.records.every((record) => record.migrations.length === 1));

      const [fakeReplay, nativeReplay] = await Promise.all([
        result(fake.migrateRecords, transaction),
        result(native.migrateRecords, transaction),
      ]);
      assert.deepEqual(fakeReplay, nativeReplay);
      assert.equal(fakeReplay.ok, true);
      assert.equal(fakeReplay.value.replayed, true);
      assert.deepEqual(fakeApplied.value.records, fakeReplay.value.records);
      await Promise.all([fakeActivation.dispose(), nativeFixture.activation.dispose()]);
    },
  ), propertyParameters());
});
