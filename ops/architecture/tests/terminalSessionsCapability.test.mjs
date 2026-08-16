import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { createServer } from "vite";

let createFakeTerminalSessionsServiceProvider;
let createTestActivationIdentity;
let SemanticServiceTestHost;
let terminalDriverId;
let terminalSessionsService;
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
  ({ terminalDriverId, terminalSessionsService } = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ));
  ({
    createFakeTerminalSessionsServiceProvider,
    createTestActivationIdentity,
    SemanticServiceTestHost,
  } = await vite.ssrLoadModule("/module-api/frontend/src/testing.ts"));
});

after(async () => {
  await vite?.close();
});

const MODULE_ID = "fixture.terminal";
const ACTIVATION_ID = "fixture.terminal@1#active";
const TERMINAL_ID = "fixture-terminal";
const SESSION_ID = "fixture-session";
const DRIVER_ID = "thin-terminal";

function fixture(options = {}) {
  const history = [];
  const seeded = {
    id: SESSION_ID,
    terminalId: TERMINAL_ID,
    moduleId: MODULE_ID,
    projectPath: "/workspace",
    ownerKey: "fixture:terminal",
    label: "Fixture terminal",
  };
  const fake = createFakeTerminalSessionsServiceProvider({
    history,
    seeds: [{ session: seeded, driverId: terminalDriverId(DRIVER_ID) }],
    ...options,
  });
  const identity = createTestActivationIdentity(MODULE_ID, ACTIVATION_ID);
  const host = new SemanticServiceTestHost([fake.provider]);
  const activation = host.activate(identity);
  return {
    activation,
    fake: fake.host,
    history,
    service: activation.context.services.require(terminalSessionsService),
  };
}

test("architecture.terminal-sessions-service-fake.property", async () => {
  await fc.assert(fc.asyncProperty(
    fc.uint8Array(),
    fc.uint8Array(),
    fc.integer({ min: 1, max: 65_535 }),
    fc.integer({ min: 1, max: 65_535 }),
    async (keyBytes, pasteBytes, columns, rows) => {
      const current = fixture();
      const lifecycle = [];
      await current.service.lifecycle.subscribe({ owner: "activation" }, (event) => {
        lifecycle.push(event.value);
      });
      const deliveries = [];
      const attachment = await current.service.bytes.attach({
        terminalId: TERMINAL_ID,
        driverId: terminalDriverId(DRIVER_ID),
        claimsResize: true,
        afterSequence: null,
        initialCredit: 1,
      }, (delivery) => { deliveries.push(delivery); });

      const focus = await current.service.focusSession.execute({ sessionId: SESSION_ID });
      const key = await current.service.writeInput.execute({
        terminalId: TERMINAL_ID,
        attachmentId: attachment.id,
        source: "key",
        bytes: keyBytes,
      });
      const paste = await current.service.writeInput.execute({
        terminalId: TERMINAL_ID,
        attachmentId: attachment.id,
        source: "paste",
        bytes: pasteBytes,
      });
      const resize = await current.service.resize.execute({
        terminalId: TERMINAL_ID,
        attachmentId: attachment.id,
        columns,
        rows,
      });
      assert.equal(focus.result.ok, true);
      assert.equal(key.result.ok, true);
      assert.equal(paste.result.ok, true);
      assert.equal(resize.result.ok, true);

      await current.fake.appendOutput(TERMINAL_ID, keyBytes);
      assert.equal(deliveries.length, 1);
      attachment.acknowledge(deliveries[0].sequence);
      await current.fake.appendOutput(TERMINAL_ID, pasteBytes);
      assert.equal(deliveries.length, 1);
      attachment.grant(1);
      await Promise.resolve();
      assert.equal(deliveries.length, 2);
      attachment.acknowledge(deliveries[1].sequence);

      await current.fake.exit(TERMINAL_ID, 0);
      assert.deepEqual(lifecycle.map(({ type }) => type), ["exited"]);
      assert.equal(deliveries.at(-1).type, "disconnected");
      assert.equal(deliveries.at(-1).resumable, false);
      assert.deepEqual(
        current.history.map(({ type }) => type),
        ["focus", "input", "input", "resize", "exit", "attachment-disposed"],
      );
      assert.deepEqual(current.history[1].bytes, [...keyBytes]);
      assert.deepEqual(current.history[2].bytes, [...pasteBytes]);
      await current.activation.dispose();
    },
  ), propertyParameters());
});

test("architecture.service-stream.terminal-sessions.property", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.uint8Array()), async (frames) => {
    const current = fixture();
    const first = [];
    const firstAttachment = await current.service.bytes.attach({
      terminalId: TERMINAL_ID,
      driverId: terminalDriverId(DRIVER_ID),
      claimsResize: false,
      afterSequence: null,
      initialCredit: 0,
    }, (delivery) => { first.push(delivery); });
    for (const bytes of frames) await current.fake.appendOutput(TERMINAL_ID, bytes);
    assert.deepEqual(first, []);

    for (let index = 0; index < frames.length; index += 1) {
      firstAttachment.grant(1);
      await new Promise((resolve) => setImmediate(resolve));
      const delivery = first[index];
      assert.equal(delivery.type, "frame");
      assert.equal(delivery.sequence, index + 1);
      assert.deepEqual([...delivery.value.bytes], [...frames[index]]);
      if (index < frames.length - 1) firstAttachment.acknowledge(delivery.sequence);
    }
    await firstAttachment.dispose();

    if (frames.length > 0) {
      const reattached = [];
      const replacement = await current.service.bytes.attach({
        terminalId: TERMINAL_ID,
        driverId: terminalDriverId(DRIVER_ID),
        claimsResize: false,
        afterSequence: frames.length - 1,
        initialCredit: 1,
      }, (delivery) => { reattached.push(delivery); });
      assert.deepEqual(reattached.map(({ type }) => type), ["gap"]);
      await current.fake.appendOutput(TERMINAL_ID, new Uint8Array([3]));
      assert.deepEqual(reattached.map(({ type }) => type), ["gap", "frame"]);
      assert.deepEqual([...reattached[1].value.bytes], [3]);
      await replacement.dispose();
    }
    await current.activation.dispose();
  }), propertyParameters());
});

test("architecture.service-event.terminal-sessions.property", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.string()), async (labels) => {
    const current = fixture();
    const lifecycle = [];
    await current.service.lifecycle.subscribe({ owner: "activation" }, (event) => {
      lifecycle.push(event);
    });
    for (const label of labels) {
      const outcome = await current.service.updateSession.execute({
        sessionId: SESSION_ID,
        patch: { label },
      });
      assert.equal(outcome.result.ok, true);
    }
    assert.deepEqual(lifecycle.map(({ sequence }) => sequence),
      labels.map((_, index) => index + 1));
    assert.deepEqual(lifecycle.map(({ value }) => value.session.label), labels);
    await current.activation.dispose();
  }), propertyParameters());
});

test("architecture.terminal-sessions-activation-ownership.property", async () => {
  const current = fixture();
  const attachment = await current.service.bytes.attach({
    terminalId: TERMINAL_ID,
    driverId: terminalDriverId(DRIVER_ID),
    claimsResize: true,
    afterSequence: null,
    initialCredit: 0,
  }, () => {});
  await current.activation.dispose();
  assert.equal(attachment.disposed, true);

  const disposedInput = await current.service.writeInput.execute({
    terminalId: TERMINAL_ID,
    attachmentId: attachment.id,
    source: "key",
    bytes: new Uint8Array([1]),
  });
  assert.equal(disposedInput.result.ok, false);
  assert.equal(disposedInput.result.error.code, "terminal-sessions.activation.disposed");
  assert.equal(current.history.some(({ type }) => type === "input"), false);
  assert.equal(current.history.at(-1).type, "attachment-disposed");
});
