import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { createServer } from "vite";

let vite;
let createFakeProjectDocumentsServiceProvider;
let createProjectDocumentsServiceProvider;
let createTestActivationIdentity;
let projectDocumentsService;
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
  ({ projectDocumentsService } = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ), propertyParameters());
  ({
    createFakeProjectDocumentsServiceProvider,
    createTestActivationIdentity,
    SemanticServiceTestHost,
  } = await vite.ssrLoadModule("/module-api/frontend/src/testing.ts"));
  ({ createProjectDocumentsServiceProvider } = await vite.ssrLoadModule(
    "/core/frontend/platform/projectDocuments.ts",
  ), propertyParameters());
  ({ SemanticServiceRegistry } = await vite.ssrLoadModule(
    "/core/frontend/runtime/index.ts",
  ), propertyParameters());
});

after(async () => {
  await vite?.close();
});

const segmentArbitrary = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._ -]*$/u);
const relativePathArbitrary = fc.array(segmentArbitrary, { minLength: 1 })
  .map((segments) => segments.join("/"));
const projectIdArbitrary = fc.string({ minLength: 1 })
  .filter((value) => value.trim().length > 0);
const rawDocumentArbitrary = fc.record({
  projectId: projectIdArbitrary,
  relativePath: relativePathArbitrary,
  contents: fc.string(),
  revision: fc.string({ minLength: 1 }),
});

function transportWith(overrides = {}) {
  return {
    discover: async () => [],
    read: async () => { throw new Error("unexpected read"); },
    write: async () => { throw new Error("unexpected write"); },
    releaseActivation: async () => true,
    ...overrides,
  };
}

function productionService(transport) {
  const registry = new SemanticServiceRegistry([
    createProjectDocumentsServiceProvider({ transport }),
  ]);
  const identity = createTestActivationIdentity("shipctl.todos");
  const activation = registry.activate(identity);
  return {
    activation,
    identity,
    service: activation.context.services.require(projectDocumentsService),
  };
}

test("architecture.service-adapter.service.property", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(rawDocumentArbitrary),
    async (rawDocuments) => {
      const requests = [];
      const transport = transportWith({
        discover: async (request) => {
          requests.push(request);
          return rawDocuments;
        },
      });
      const { activation, identity, service } = productionService(transport);
      const input = { projectId: "/project", fileNames: ["todo.md", "todos.md"] };
      const outcome = await service.discoverDocuments.execute(input);
      assert.equal(outcome.result.ok, true);
      assert.deepEqual(outcome.result.value, rawDocuments.map((document) => ({
        projectId: document.projectId,
        relativePath: document.relativePath,
        contents: document.contents,
        revision: document.revision,
      })));
      assert.deepEqual(requests, [{
        activation: identity,
        correlationId: outcome.correlationId,
        input,
      }]);
      await activation.dispose();
    },
  ));

  await fc.assert(fc.asyncProperty(
    fc.constantFrom(
      "project-documents.denied",
      "project-documents.invalid-project",
      "project-documents.not-found",
      "project-documents.conflict",
      "project-documents.too-large",
      "project-documents.invalid-request",
    ),
    fc.string(),
    async (code, message) => {
      const { activation, service } = productionService(transportWith({
        read: async () => { throw { code, message }; },
      }));
      const outcome = await service.readDocument.execute({
        projectId: "/project",
        relativePath: "TODO.md",
      });
      assert.deepEqual(outcome.result, {
        ok: false,
        error: { code, message, retryable: false },
      });
      await activation.dispose();
    },
  ), propertyParameters());
});

test("architecture.service-request.service.property", async () => {
  await fc.assert(fc.asyncProperty(
    projectIdArbitrary,
    fc.string(),
    async (projectId, contents) => {
      const dispatches = [];
      const { activation, identity, service } = productionService(transportWith({
        write: async (request) => {
          dispatches.push(request);
          return {
            ...request.input,
            revision: "next-revision",
          };
        },
      }));
      for (const relativePath of ["", "/absolute.md", "../escape.md", "a/../escape.md", "a//b.md"]) {
        const invalid = await service.writeDocument.execute({
          projectId,
          relativePath,
          expectedRevision: null,
          contents,
        });
        assert.equal(invalid.result.ok, false);
        assert.equal(invalid.result.error.code, "project-documents.invalid-path");
      }
      assert.equal(dispatches.length, 0);

      const cancelled = await service.writeDocument.execute(
        {
          projectId,
          relativePath: "TODO.md",
          expectedRevision: null,
          contents,
        },
        { cancellation: { cancelled: true } },
      );
      assert.equal(cancelled.result.ok, false);
      assert.equal(cancelled.result.error.code, "project-documents.cancelled");
      assert.equal(dispatches.length, 0);

      const written = await service.writeDocument.execute({
        projectId,
        relativePath: "TODO.md",
        expectedRevision: null,
        contents,
      });
      assert.equal(written.result.ok, true);
      assert.equal(dispatches.length, 1);
      assert.deepEqual(dispatches[0].activation, identity);
      assert.equal(dispatches[0].correlationId, written.correlationId);

      await activation.dispose();
      const disposed = await service.readDocument.execute({
        projectId,
        relativePath: "TODO.md",
      });
      assert.equal(disposed.result.ok, false);
      assert.equal(disposed.result.error.code, "project-documents.activation-disposed");
      assert.equal(dispatches.length, 1);
    },
  ));
});

test("architecture.project-documents-release.service.property", async () => {
  await fc.assert(fc.asyncProperty(
    projectIdArbitrary,
    async (projectId) => {
      const releases = [];
      let nextCorrelation = 0;
      const registry = new SemanticServiceRegistry([
        createProjectDocumentsServiceProvider({
          transport: transportWith({
            read: async (request) => ({
              ...request.input,
              contents: "",
              revision: "revision",
            }),
            releaseActivation: async (request) => {
              releases.push(request);
              return true;
            },
          }),
          createCorrelationId: () => `correlation-${nextCorrelation += 1}`,
        }),
      ]);
      const identity = createTestActivationIdentity("shipctl.todos");
      const activation = registry.activate(identity);
      const service = activation.context.services.require(projectDocumentsService);
      const read = await service.readDocument.execute({
        projectId,
        relativePath: "TODO.md",
      });
      assert.equal(read.result.ok, true);

      await activation.dispose();
      assert.deepEqual(releases, [{
        activation: identity,
        correlationId: "correlation-2",
        input: {},
      }]);
      await activation.dispose();
      assert.equal(releases.length, 1);
    },
  ), propertyParameters());
});

test("architecture.project-documents-service-fake.property", async () => {
  await fc.assert(fc.asyncProperty(
    projectIdArbitrary,
    relativePathArbitrary,
    fc.string(),
    fc.string(),
    async (projectId, relativePath, firstContents, secondContents) => {
      const trace = [];
      const host = new SemanticServiceTestHost([
        createFakeProjectDocumentsServiceProvider({ trace }),
      ]);
      const activation = host.activate(createTestActivationIdentity("shipctl.todos"));
      const service = activation.context.services.require(projectDocumentsService);

      const created = await service.writeDocument.execute({
        projectId,
        relativePath,
        expectedRevision: null,
        contents: firstContents,
      });
      assert.equal(created.result.ok, true);
      const revision = created.result.value.revision;

      const duplicateCreate = await service.writeDocument.execute({
        projectId,
        relativePath,
        expectedRevision: null,
        contents: secondContents,
      });
      assert.equal(duplicateCreate.result.ok, false);
      assert.equal(duplicateCreate.result.error.code, "project-documents.conflict");

      const stale = await service.writeDocument.execute({
        projectId,
        relativePath,
        expectedRevision: "stale-revision",
        contents: secondContents,
      });
      assert.equal(stale.result.ok, false);
      assert.equal(stale.result.error.code, "project-documents.conflict");

      const updated = await service.writeDocument.execute({
        projectId,
        relativePath,
        expectedRevision: revision,
        contents: secondContents,
      });
      assert.equal(updated.result.ok, true);
      assert.equal(updated.result.value.contents, secondContents);
      assert.notEqual(updated.result.value.revision, revision);

      const read = await service.readDocument.execute({ projectId, relativePath });
      assert.deepEqual(read.result, { ok: true, value: updated.result.value });
      assert.ok(trace.every(({ request }) =>
        request.activation.activationId === activation.context.identity.activationId));
      await activation.dispose();
    },
  ));
});
