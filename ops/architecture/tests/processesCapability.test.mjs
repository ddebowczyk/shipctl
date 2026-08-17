import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { createServer } from "vite";

let vite;
let createFakeProcessesServiceProvider;
let createProcessesServiceProvider;
let createTestActivationIdentity;
let processesService;
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
  ({ processesService } = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ));
  ({
    createFakeProcessesServiceProvider,
    createTestActivationIdentity,
    SemanticServiceTestHost,
  } = await vite.ssrLoadModule("/module-api/frontend/src/testing.ts"));
  ({ createProcessesServiceProvider } = await vite.ssrLoadModule(
    "/core/frontend/platform/processes.ts",
  ));
  ({ SemanticServiceRegistry } = await vite.ssrLoadModule(
    "/core/frontend/runtime/index.ts",
  ));
});

after(async () => {
  await vite?.close();
});

const inspectionIdArbitrary = fc.uuid();
const inspectionArbitrary = fc.record({
  inspectionId: inspectionIdArbitrary,
  port: fc.integer({ min: 0, max: 65_535 }),
  processId: fc.integer({ min: 0, max: 4_294_967_295 }),
  name: fc.string(),
  workingDirectory: fc.string(),
  commandLine: fc.string(),
  observedProjectFiles: fc.uniqueArray(fc.string(), { maxLength: 12 }),
  uptime: fc.string(),
  memoryKilobytes: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
});

const inspectionsArbitrary = fc.uniqueArray(inspectionArbitrary, {
  selector: ({ inspectionId }) => inspectionId,
});

const scanInput = {
  projectRootMarkers: ["package.json", "Cargo.toml"],
  observedProjectFileNames: ["vite.config.ts", "Cargo.toml"],
};

function productionService(transport) {
  let correlationSequence = 0;
  const registry = new SemanticServiceRegistry([
    createProcessesServiceProvider({
      transport,
      createCorrelationId: () => `correlation-${correlationSequence++}`,
    }),
  ]);
  const identity = createTestActivationIdentity("shipctl.ports");
  const activation = registry.activate(identity);
  return {
    activation,
    identity,
    service: activation.context.services.require(processesService),
  };
}

function transport(overrides = {}) {
  return {
    inspectListeningProcesses: async () => [],
    terminateInspectedProcess: async (request) => ({
      inspectionId: request.input.inspectionId,
    }),
    inspectCommand: async (request) => ({
      command: request.input.command.trim(),
      available: false,
    }),
    releaseProcessInspections: async () => 0,
    ...overrides,
  };
}

test("architecture.service-adapter.processes.property", async () => {
  await fc.assert(fc.asyncProperty(inspectionsArbitrary, async (inspections) => {
    const requests = [];
    const candidate = transport({
      inspectListeningProcesses: async (request) => {
        requests.push(request);
        return inspections;
      },
    });
    const { activation, identity, service } = productionService(candidate);
    const outcome = await service.inspectListeningPorts.execute(scanInput);
    assert.deepEqual(outcome.result, { ok: true, value: inspections });
    assert.deepEqual(requests, [{
      activation: identity,
      correlationId: outcome.correlationId,
      input: scanInput,
    }]);
    await activation.dispose();
  }), propertyParameters());

  await fc.assert(fc.asyncProperty(
    fc.constantFrom("processes.denied", "processes.stale-inspection"),
    fc.string({ minLength: 1 }),
    async (code, message) => {
      const candidate = transport({
        inspectListeningProcesses: async () => {
          throw { code, message, retryable: false };
        },
      });
      const { activation, service } = productionService(candidate);
      const outcome = await service.inspectListeningPorts.execute(scanInput);
      assert.deepEqual(outcome.result, {
        ok: false,
        error: { code, message, retryable: false },
      });
      await activation.dispose();
    },
  ), propertyParameters());
});

test("architecture.service-request.processes.property", async () => {
  await fc.assert(fc.asyncProperty(
    inspectionIdArbitrary,
    fc.boolean(),
    async (inspectionId, cancelled) => {
      const terminations = [];
      const releases = [];
      const candidate = transport({
        terminateInspectedProcess: async (request) => {
          terminations.push(request);
          return { inspectionId: request.input.inspectionId };
        },
        releaseProcessInspections: async (request) => {
          releases.push(request);
          return 1;
        },
      });
      const { activation, identity, service } = productionService(candidate);
      const outcome = await service.terminateInspectedProcess.execute(
        { inspectionId },
        { cancellation: { cancelled, subscribe: () => assert.fail("must not subscribe") } },
      );
      if (cancelled) {
        assert.equal(outcome.result.ok, false);
        assert.equal(outcome.result.error.code, "processes.cancelled");
        assert.equal(terminations.length, 0);
      } else {
        assert.deepEqual(outcome.result, {
          ok: true,
          value: { inspectionId },
        });
        assert.deepEqual(terminations, [{
          activation: identity,
          correlationId: outcome.correlationId,
          input: { inspectionId },
        }]);
      }

      await activation.dispose();
      assert.equal(releases.length, 1);
      assert.equal(releases[0].activation, identity);
      assert.deepEqual(releases[0].input, {});

      const callsBeforeDisposedRequest = terminations.length;
      const disposed = await service.terminateInspectedProcess.execute({ inspectionId });
      assert.equal(disposed.result.ok, false);
      assert.equal(disposed.result.error.code, "processes.activation-disposed");
      assert.equal(terminations.length, callsBeforeDisposedRequest);
    },
  ), propertyParameters());
});

test("architecture.processes-service-fake.property", async () => {
  await fc.assert(fc.asyncProperty(
    inspectionsArbitrary,
    fc.uniqueArray(fc.string({ minLength: 1 }).filter((value) => value.trim().length > 0)),
    fc.string(),
    async (inspections, availableCommands, query) => {
      const trace = [];
      const host = new SemanticServiceTestHost([
        createFakeProcessesServiceProvider({
          inspections: () => inspections,
          availableCommands: availableCommands.map((command) => command.trim()),
          trace,
        }),
      ]);
      const activation = host.activate(createTestActivationIdentity("shipctl.ports"));
      const service = activation.context.services.require(processesService);

      const scan = await service.inspectListeningPorts.execute(scanInput);
      assert.deepEqual(scan.result, { ok: true, value: inspections });

      const traceCount = trace.length;
      const cancelled = await service.inspectCommand.execute(
        { command: query },
        { cancellation: { cancelled: true } },
      );
      assert.equal(cancelled.result.ok, false);
      assert.equal(cancelled.result.error.code, "processes.cancelled");
      assert.equal(trace.length, traceCount);

      const command = await service.inspectCommand.execute({ command: query });
      if (query.trim().length === 0) {
        assert.equal(command.result.ok, false);
        assert.equal(command.result.error.code, "processes.invalid-request");
      } else {
        assert.deepEqual(command.result, {
          ok: true,
          value: {
            command: query.trim(),
            available: availableCommands.map((item) => item.trim()).includes(query.trim()),
          },
        });
      }

      if (inspections.length > 0) {
        const selected = inspections[0];
        const stopped = await service.terminateInspectedProcess.execute({
          inspectionId: selected.inspectionId,
        });
        assert.deepEqual(stopped.result, {
          ok: true,
          value: { inspectionId: selected.inspectionId },
        });
        const stale = await service.terminateInspectedProcess.execute({
          inspectionId: selected.inspectionId,
        });
        assert.equal(stale.result.ok, false);
        assert.equal(stale.result.error.code, "processes.stale-inspection");
      }
      assert.ok(trace.every(({ request }) =>
        request.activation.activationId === activation.context.identity.activationId));
      await activation.dispose();
    },
  ), propertyParameters());
});
