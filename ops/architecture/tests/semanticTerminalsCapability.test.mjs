import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { createServer } from "vite";

let createFakeSemanticTerminalScreenState;
let createFakeSemanticTerminalsServiceProvider;
let createTestActivationIdentity;
let SemanticServiceTestHost;
let semanticTerminalsService;
let vite;

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
  ({ semanticTerminalsService } = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ));
  ({
    createFakeSemanticTerminalScreenState,
    createFakeSemanticTerminalsServiceProvider,
    createTestActivationIdentity,
    SemanticServiceTestHost,
  } = await vite.ssrLoadModule("/module-api/frontend/src/testing.ts"));
});

after(async () => {
  await vite?.close();
});

const MODULE_ID = "fixture.semantic-terminal";
const ACTIVATION_ID = "fixture.semantic-terminal@1#active";
const TERMINAL_ID = "fixture-semantic-terminal";

function fixture(options = {}) {
  const traces = [];
  const history = [];
  const fake = createFakeSemanticTerminalsServiceProvider({
    traces,
    history,
    seeds: [{
      moduleId: MODULE_ID,
      terminalId: TERMINAL_ID,
      state: createFakeSemanticTerminalScreenState(2, 1),
      history: {
        startRow: 0,
        historyRows: 1,
        rows: [{
          wrapped: false,
          continuation: false,
          prompt: "prompt",
          cells: [{
            text: "$",
            width: "narrow",
            bold: true,
            foreground: null,
            background: null,
            selected: false,
          }],
        }],
      },
    }],
    ...options,
  });
  const identity = createTestActivationIdentity(MODULE_ID, ACTIVATION_ID);
  const activation = new SemanticServiceTestHost([fake.provider]).activate(identity);
  return {
    activation,
    fake: fake.host,
    history,
    service: activation.context.services.require(semanticTerminalsService),
    traces,
  };
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("architecture.semantic-terminal-service-fake.property", async () => {
  await fc.assert(fc.asyncProperty(
    fc.string(),
    fc.integer({ min: 1, max: 65_535 }),
    fc.integer({ min: 1, max: 65_535 }),
    fc.nat(),
    fc.nat(),
    async (text, columns, rows, column, row) => {
      const current = fixture();
      const attachment = await current.service.screens.attach({
        terminalId: TERMINAL_ID,
        claimsResize: true,
        afterSequence: null,
        initialCredit: 0,
      }, () => undefined);

      const input = await current.service.input.execute({
        terminalId: TERMINAL_ID,
        input: { kind: "text", text },
      });
      const resize = await current.service.resize.execute({
        terminalId: TERMINAL_ID,
        attachmentId: attachment.id,
        columns,
        rows,
      });
      const history = await current.service.history.execute({
        terminalId: TERMINAL_ID,
        startRow: 0,
        rows: 1,
      });
      const created = await current.service.createAnchor.execute({
        terminalId: TERMINAL_ID,
        space: "history",
        at: { column, row },
      });
      assert.equal(created.result.ok, true);
      const resolved = await current.service.resolveAnchor.execute({
        terminalId: TERMINAL_ID,
        anchorId: created.result.value.id,
      });
      const selection = await current.service.select.execute({
        terminalId: TERMINAL_ID,
        request: { kind: "all" },
      });
      const paste = await current.service.inspectPaste.execute({ text });
      const released = await current.service.releaseAnchor.execute({
        terminalId: TERMINAL_ID,
        anchorId: created.result.value.id,
      });

      assert.equal(input.result.ok, true);
      assert.equal(input.result.value.encodedBytes, new TextEncoder().encode(text).length);
      assert.equal(resize.result.ok, true);
      assert.equal(history.result.ok, true);
      assert.equal(history.result.value.rows[0].cells[0].text, "$");
      assert.deepEqual(resolved.result.ok && resolved.result.value?.history, { column, row });
      assert.deepEqual(selection.result.ok && selection.result.value, { active: true, text: "" });
      assert.equal(paste.result.ok && paste.result.value.safe, !/[\r\n]/u.test(text));
      assert.equal(released.result.ok && released.result.value.released, true);
      assert.deepEqual(current.history.map(({ type }) => type), ["input", "resize"]);
      assert.ok(current.traces.every(
        ({ request }) => request.activation.activationId === ACTIVATION_ID,
      ));
      await current.activation.dispose();
    },
  ), propertyParameters());
});

test("architecture.service-stream.semantic-terminal.property", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.array(fc.string(), { minLength: 1 })),
    async (bursts) => {
      const current = fixture();
      const deliveries = [];
      const attachment = await current.service.screens.attach({
        terminalId: TERMINAL_ID,
        claimsResize: false,
        afterSequence: null,
        initialCredit: 0,
      }, (delivery) => { deliveries.push(delivery); });
      assert.equal(attachment.active, false);
      attachment.activate();

      let revision = attachment.snapshot.revision;
      for (const burst of bursts) {
        const before = deliveries.length;
        for (const title of burst) {
          revision = await current.fake.publishScreen(
            TERMINAL_ID,
            createFakeSemanticTerminalScreenState(2, 1),
            [{ kind: "title", title }],
          );
        }
        assert.equal(deliveries.length, before);
        attachment.grant(1);
        await settle();
        assert.equal(deliveries.length, before + 1);
        const delivered = deliveries.at(-1);
        assert.equal(delivered.type, "frame");
        assert.equal(delivered.sequence, revision);
        assert.equal(delivered.value.revision, revision);
        assert.deepEqual(
          delivered.value.effects.map(({ title }) => title),
          burst,
        );
        attachment.acknowledge(revision);
      }

      await current.activation.dispose();
      assert.equal(attachment.disposed, true);
      assert.equal(deliveries.some(({ type }) => type === "disconnected"), false);
    },
  ), propertyParameters());
});

test("architecture.semantic-terminal-activation.property", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.string()), async (inputs) => {
    const current = fixture();
    const attachment = await current.service.screens.attach({
      terminalId: TERMINAL_ID,
      claimsResize: false,
      afterSequence: null,
      initialCredit: 0,
    }, () => undefined);
    for (const text of inputs) {
      const outcome = await current.service.input.execute({
        terminalId: TERMINAL_ID,
        input: { kind: "text", text },
      });
      assert.equal(outcome.result.ok, true);
    }
    assert.deepEqual(
      current.traces.map(({ request }) => request.activation.activationId),
      inputs.map(() => ACTIVATION_ID),
    );
    await current.activation.dispose();
    assert.equal(attachment.disposed, true);

    const disposed = await current.service.input.execute({
      terminalId: TERMINAL_ID,
      input: { kind: "text", text: "after-dispose" },
    });
    assert.equal(disposed.result.ok, false);
    assert.equal(disposed.result.error.code, "semantic-terminals.activation.disposed");
    assert.equal(current.history.some(
      ({ type, detail }) => type === "input" && detail.text === "after-dispose",
    ), false);
  }), propertyParameters());
});
