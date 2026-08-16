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

const rawPortArbitrary = fc.record({
  port: fc.integer({ min: 0, max: 65_535 }),
  pid: fc.integer({ min: 0, max: 4_294_967_295 }),
  process: fc.string(),
  cwd: fc.string(),
  project: fc.string(),
  framework: fc.string(),
  uptime: fc.string(),
  memoryKb: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
});

const rawPortsArbitrary = fc.uniqueArray(rawPortArbitrary, {
  selector: ({ port }) => port,
});

function productionService(transport, prefix = "inspection") {
  let nextInspection = 0;
  const registry = new SemanticServiceRegistry([
    createProcessesServiceProvider({
      transport,
      createInspectionId: () => `${prefix}-${nextInspection++}`,
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

function expectedInspection(raw, inspectionId) {
  return {
    inspectionId,
    port: raw.port,
    processId: raw.pid,
    name: raw.process,
    workingDirectory: raw.cwd,
    projectName: raw.project,
    framework: raw.framework,
    uptime: raw.uptime,
    memoryKilobytes: raw.memoryKb,
  };
}

test("architecture.service-adapter.service.property", async () => {
  await fc.assert(fc.asyncProperty(rawPortsArbitrary, async (rawPorts) => {
    const requests = [];
    const transport = {
      listListeningPorts: async (request) => {
        requests.push(request);
        return rawPorts;
      },
      terminateProcess: async () => undefined,
      inspectCommand: async () => false,
    };
    const { activation, identity, service } = productionService(transport);
    const outcome = await service.inspectListeningPorts.execute({});
    assert.equal(outcome.result.ok, true);
    assert.deepEqual(
      outcome.result.value,
      rawPorts.map((raw, index) => expectedInspection(raw, `inspection-${index}`)),
    );
    assert.deepEqual(requests, [{
      activation: identity,
      correlationId: outcome.correlationId,
      input: {},
    }]);
    await activation.dispose();
  }));

  await fc.assert(fc.asyncProperty(
    fc.string({ minLength: 1 }),
    fc.boolean(),
    async (detail, denied) => {
      const message = denied ? `permission denied: ${detail}` : `scan failed: ${detail}`;
      const { activation, service } = productionService({
        listListeningPorts: async () => { throw new Error(message); },
        terminateProcess: async () => undefined,
        inspectCommand: async () => false,
      });
      const outcome = await service.inspectListeningPorts.execute({});
      assert.deepEqual(outcome.result, {
        ok: false,
        error: {
          code: denied ? "processes.denied" : "processes.transport-failed",
          message,
          retryable: false,
        },
      });
      await activation.dispose();
    },
  ));
});

test("architecture.service-request.service.property", async () => {
  await fc.assert(fc.asyncProperty(
    rawPortArbitrary,
    rawPortArbitrary,
    fc.boolean(),
    fc.boolean(),
    fc.string(),
    async (firstRaw, secondRaw, denied, cancelled, unknownSuffix) => {
      const scans = [[firstRaw], [secondRaw]];
      const terminations = [];
      const transport = {
        listListeningPorts: async () => scans.shift() ?? [],
        terminateProcess: async (processId, request) => {
          terminations.push({ processId, request });
          if (denied) throw new Error("operation not permitted");
        },
        inspectCommand: async () => false,
      };
      const { activation, identity, service } = productionService(transport);
      const firstScan = await service.inspectListeningPorts.execute({});
      const secondScan = await service.inspectListeningPorts.execute({});
      assert.equal(firstScan.result.ok, true);
      assert.equal(secondScan.result.ok, true);
      const first = firstScan.result.value[0];
      const second = secondScan.result.value[0];

      const stale = await service.terminateInspectedProcess.execute({
        inspectionId: first.inspectionId,
      });
      assert.equal(stale.result.ok, false);
      assert.equal(stale.result.error.code, "processes.stale-inspection");
      assert.equal(terminations.length, 0);

      const unknown = await service.terminateInspectedProcess.execute({
        inspectionId: `unknown:${unknownSuffix}`,
      });
      assert.equal(unknown.result.ok, false);
      assert.equal(unknown.result.error.code, "processes.stale-inspection");
      assert.equal(terminations.length, 0);

      const cancellation = {
        cancelled,
        subscribe: () => { throw new Error("pre-dispatch cancellation must not subscribe"); },
      };
      const current = await service.terminateInspectedProcess.execute(
        { inspectionId: second.inspectionId },
        { cancellation },
      );
      if (cancelled) {
        assert.equal(current.result.ok, false);
        assert.equal(current.result.error.code, "processes.cancelled");
        assert.equal(terminations.length, 0);
      } else {
        assert.equal(terminations.length, 1);
        assert.equal(terminations[0].processId, secondRaw.pid);
        assert.deepEqual(terminations[0].request.activation, identity);
        assert.equal(terminations[0].request.correlationId, current.correlationId);
        assert.deepEqual(terminations[0].request.input, {
          inspectionId: second.inspectionId,
        });
        assert.equal(current.result.ok, !denied);
        if (denied) assert.equal(current.result.error.code, "processes.denied");
      }

      if (!cancelled && !denied) {
        const repeated = await service.terminateInspectedProcess.execute({
          inspectionId: second.inspectionId,
        });
        assert.equal(repeated.result.ok, false);
        assert.equal(repeated.result.error.code, "processes.stale-inspection");
        assert.equal(terminations.length, 1);
      }
      await activation.dispose();
    },
  ));
});

test("architecture.processes-service-fake.property", async () => {
  await fc.assert(fc.asyncProperty(
    rawPortsArbitrary,
    fc.uniqueArray(fc.string({ minLength: 1 }).filter((value) => value.trim().length > 0)),
    fc.string(),
    async (rawPorts, availableCommands, query) => {
      const inspections = rawPorts.map((raw, index) =>
        expectedInspection(raw, `fake-${index}`));
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

      const scan = await service.inspectListeningPorts.execute({});
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
  ));
});
