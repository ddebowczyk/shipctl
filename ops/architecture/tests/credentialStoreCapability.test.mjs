import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { createServer } from "vite";

let vite;
let createCredentialStoreServiceProvider;
let createFakeCredentialStoreServiceProvider;
let createTestActivationIdentity;
let credentialId;
let credentialStoreService;
let piCredentialClientFor;
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
  ({ credentialId, credentialStoreService } = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ));
  ({
    createFakeCredentialStoreServiceProvider,
    createTestActivationIdentity,
    SemanticServiceTestHost,
  } = await vite.ssrLoadModule("/module-api/frontend/src/testing.ts"));
  ({ createCredentialStoreServiceProvider } = await vite.ssrLoadModule(
    "/core/frontend/platform/credentials.ts",
  ));
  ({ SemanticServiceRegistry } = await vite.ssrLoadModule(
    "/core/frontend/runtime/index.ts",
  ));
  ({ piCredentialClientFor } = await vite.ssrLoadModule(
    "/modules/assistants/frontend/src/credentialStoreClient.ts",
  ));
});

after(async () => {
  await vite?.close();
});

const providerIdArbitrary = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const secretArbitrary = fc.uuid().map((value) => `shipctl-secret-${value}`);

function productionService({
  moduleId = "shipctl.assistants",
  transport,
  authorize,
}) {
  const registry = new SemanticServiceRegistry([
    createCredentialStoreServiceProvider({ transport, authorize }),
  ]);
  const identity = createTestActivationIdentity(moduleId);
  const activation = registry.activate(identity);
  return {
    activation,
    identity,
    service: activation.context.services.require(credentialStoreService),
  };
}

test("architecture.service-adapter.credential-store.property", async () => {
  await fc.assert(fc.asyncProperty(
    providerIdArbitrary,
    secretArbitrary,
    async (provider, secret) => {
      const id = credentialId("pi.api-key", provider);
      let savedRequest;
      const { activation, identity, service } = productionService({
        transport: {
          hasCredential: async () => false,
          saveCredential: async (request) => { savedRequest = request; },
          deleteCredential: async () => undefined,
          releaseActivation: async () => true,
        },
      });
      const outcome = await service.saveCredential.execute({ credentialId: id, secret });
      assert.deepEqual(outcome.result, {
        ok: true,
        value: { credentialId: id, configured: true },
      });
      assert.equal(savedRequest.activation, identity);
      assert.equal(savedRequest.correlationId, outcome.correlationId);
      assert.equal(savedRequest.input.secret, secret);
      assert.equal(JSON.stringify(outcome).includes(secret), false);
      await activation.dispose();
    },
  ), propertyParameters());

  await fc.assert(fc.asyncProperty(
    providerIdArbitrary,
    secretArbitrary,
    fc.constantFrom("permission denied", "unknown command", "keychain failed"),
    async (provider, secret, failure) => {
      const { activation, service } = productionService({
        transport: {
          hasCredential: async () => false,
          saveCredential: async () => { throw new Error(`${failure}: ${secret}`); },
          deleteCredential: async () => undefined,
          releaseActivation: async () => true,
        },
      });
      const outcome = await service.saveCredential.execute({
        credentialId: credentialId("pi.api-key", provider),
        secret,
      });
      assert.equal(outcome.result.ok, false);
      assert.equal(JSON.stringify(outcome).includes(secret), false);
      assert.equal(
        outcome.result.error.code,
        failure === "permission denied"
          ? "credential-store.denied"
          : failure === "unknown command"
            ? "credential-store.unavailable"
            : "credential-store.transport-failed",
      );
      await activation.dispose();
    },
  ), propertyParameters());
});

test("architecture.service-request.credential-store.property", async () => {
  await fc.assert(fc.asyncProperty(
    providerIdArbitrary,
    secretArbitrary,
    fc.constantFrom("has", "save", "delete"),
    fc.boolean(),
    fc.boolean(),
    async (provider, secret, operation, admitted, cancelled) => {
      const authorizations = [];
      const dispatches = [];
      const id = credentialId("pi.api-key", provider);
      const transport = {
        hasCredential: async (request) => { dispatches.push(["has", request]); return false; },
        saveCredential: async (request) => { dispatches.push(["save", request]); },
        deleteCredential: async (request) => { dispatches.push(["delete", request]); },
        releaseActivation: async () => true,
      };
      const { activation, identity, service } = productionService({
        transport,
        authorize: (request) => { authorizations.push(request); return admitted; },
      });
      const options = { cancellation: { cancelled } };
      const outcome = operation === "has"
        ? await service.hasCredential.execute({ credentialId: id }, options)
        : operation === "save"
          ? await service.saveCredential.execute({ credentialId: id, secret }, options)
          : await service.deleteCredential.execute({ credentialId: id }, options);

      const expectedCode = cancelled
        ? "credential-store.cancelled"
        : admitted
          ? null
          : "credential-store.denied";
      assert.equal(outcome.result.ok, expectedCode === null);
      if (expectedCode !== null) assert.equal(outcome.result.error.code, expectedCode);
      assert.equal(authorizations.length, cancelled ? 0 : 1);
      assert.equal(dispatches.length, cancelled || !admitted ? 0 : 1);
      if (authorizations.length > 0) {
        assert.equal(authorizations[0].activation, identity);
        assert.equal(
          authorizations[0].grant,
          operation === "has" ? "credential.inspect" : "credential.write",
        );
        assert.equal(authorizations[0].credentialId, id);
      }
      if (dispatches.length > 0) {
        assert.equal(dispatches[0][0], operation);
        assert.equal(dispatches[0][1].activation, identity);
        assert.equal(dispatches[0][1].correlationId, outcome.correlationId);
      }

      await activation.dispose();
      const before = { authorizations: authorizations.length, dispatches: dispatches.length };
      const disposed = await service.hasCredential.execute({ credentialId: id });
      assert.equal(disposed.result.ok, false);
      assert.equal(disposed.result.error.code, "credential-store.activation-disposed");
      assert.deepEqual(
        { authorizations: authorizations.length, dispatches: dispatches.length },
        before,
      );
    },
  ), propertyParameters());

  await fc.assert(fc.asyncProperty(secretArbitrary, async (secret) => {
    let dispatches = 0;
    const { activation, service } = productionService({
      transport: {
        hasCredential: async () => { dispatches += 1; return false; },
        saveCredential: async () => { dispatches += 1; },
        deleteCredential: async () => { dispatches += 1; },
        releaseActivation: async () => true,
      },
    });
    const foreignScope = await service.saveCredential.execute({
      credentialId: "foreign.secret:value",
      secret,
    });
    assert.equal(foreignScope.result.ok, false);
    assert.equal(foreignScope.result.error.code, "credential-store.invalid-request");
    assert.equal(dispatches, 0);
    await activation.dispose();
  }), propertyParameters());

  await fc.assert(fc.asyncProperty(
    providerIdArbitrary,
    fc.stringMatching(/^[a-z][a-z0-9-]*$/),
    async (provider, foreignModule) => {
      fc.pre(foreignModule !== "assistants");
      let dispatches = 0;
      const { activation, service } = productionService({
        moduleId: `shipctl.${foreignModule}`,
        transport: {
          hasCredential: async () => { dispatches += 1; return false; },
          saveCredential: async () => { dispatches += 1; },
          deleteCredential: async () => { dispatches += 1; },
          releaseActivation: async () => true,
        },
      });
      const denied = await service.hasCredential.execute({
        credentialId: credentialId("pi.api-key", provider),
      });
      assert.equal(denied.result.ok, false);
      assert.equal(denied.result.error.code, "credential-store.denied");
      assert.equal(dispatches, 0);
      await activation.dispose();
    },
  ), propertyParameters());
});

test("architecture.credential-store-service-fake.property", async () => {
  await fc.assert(fc.asyncProperty(
    providerIdArbitrary,
    secretArbitrary,
    async (provider, secret) => {
      const id = credentialId("pi.api-key", provider);
      const trace = [];
      const host = new SemanticServiceTestHost([
        createFakeCredentialStoreServiceProvider({ trace }),
      ]);
      const activation = host.activate(createTestActivationIdentity("shipctl.assistants"));
      const client = piCredentialClientFor(activation.context);

      assert.equal(await client.hasApiKey(provider), false);
      await client.saveApiKey(provider, secret);
      assert.equal(await client.hasApiKey(provider), true);
      await client.deleteApiKey(provider);
      assert.equal(await client.hasApiKey(provider), false);
      assert.deepEqual(trace.map(({ operation }) => operation), [
        "has-credential",
        "save-credential",
        "has-credential",
        "delete-credential",
        "has-credential",
      ]);
      assert.equal(trace[1].credentialId, id);
      assert.equal(trace[1].secret, "[REDACTED]");
      assert.equal(JSON.stringify(trace).includes(secret), false);
      await activation.dispose();
    },
  ), propertyParameters());

  await fc.assert(fc.asyncProperty(providerIdArbitrary, async (provider) => {
    const host = new SemanticServiceTestHost([
      createFakeCredentialStoreServiceProvider({ deniedGrants: ["credential.inspect"] }),
    ]);
    const activation = host.activate(createTestActivationIdentity("shipctl.assistants"));
    const client = piCredentialClientFor(activation.context);
    await assert.rejects(client.hasApiKey(provider), /grant denied/);
    await activation.dispose();
  }), propertyParameters());
});
