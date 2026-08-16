import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { createServer } from "vite";

import { checkModuleBoundaries } from "../../modularity/bin/check-module-boundaries.mjs";

let vite;
let defineSemanticService;
let createFakeRequestOperation;
let createTestActivationIdentity;
let SemanticServiceTestHost;
let TestCancellation;
let TestEventSource;
let TestOrderedStreamSource;
let createSemanticRequestAdapter;
let SemanticServiceRegistry;

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({ defineSemanticService } = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ));
  ({
    createFakeRequestOperation,
    createTestActivationIdentity,
    SemanticServiceTestHost,
    TestCancellation,
    TestEventSource,
    TestOrderedStreamSource,
  } = await vite.ssrLoadModule("/module-api/frontend/src/testing.ts"));
  ({ createSemanticRequestAdapter } = await vite.ssrLoadModule(
    "/core/frontend/platform/index.ts",
  ));
  ({ SemanticServiceRegistry } = await vite.ssrLoadModule(
    "/core/frontend/runtime/index.ts",
  ));
});

after(async () => {
  await vite?.close();
});

const CANCELLED = {
  code: "test.request.cancelled",
  message: "Request cancelled",
  retryable: false,
};
const DISPOSED = {
  code: "test.activation.disposed",
  message: "Activation disposed",
  retryable: false,
};
const FAILED = {
  code: "test.request.failed",
  message: "Request failed",
  retryable: false,
};
const POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
};

async function boundaryFixture(sourceFiles) {
  const root = await mkdtemp(path.join(os.tmpdir(), "shipctl-service-boundary-"));
  await mkdir(path.join(root, "core/frontend/host"), { recursive: true });
  await writeFile(
    path.join(root, "core/frontend/package.json"),
    JSON.stringify({
      name: "@shipctl/core",
      exports: { "./platform": "./platform/index.ts" },
    }),
  );
  for (const [relativeRoot, name] of [
    ["module-api/frontend", "@shipctl/module-api"],
    ["modules/alpha/frontend", "@shipctl/module-alpha"],
    ["modules/beta/frontend", "@shipctl/module-beta"],
  ]) {
    const packageRoot = path.join(root, relativeRoot);
    await mkdir(path.join(packageRoot, "src"), { recursive: true });
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
      name,
      exports: { ".": "./src/index.ts" },
    }));
  }
  for (const [relative, source] of Object.entries(sourceFiles)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  return root;
}

test("architecture.plugin-imports.property", async () => {
  const edge = fc.constantFrom(
    "artifact-local",
    "module-api",
    "react-peer",
    "tauri",
    "core",
    "cordis",
    "layman",
    "cross-plugin",
    "hidden-tauri",
    "dynamic-tauri",
  );
  await fc.assert(fc.asyncProperty(edge, async (owner) => {
    const files = {
      "modules/alpha/frontend/src/local.ts": "export const local = 1;",
    };
    const allowed = new Set(["artifact-local", "module-api", "react-peer"]);
    if (owner === "artifact-local") {
      files["modules/alpha/frontend/src/index.ts"] =
        "import { local } from './local.ts'; export { local };";
    } else if (owner === "module-api") {
      files["modules/alpha/frontend/src/index.ts"] =
        "import type { ModuleId } from '@shipctl/module-api'; export type Id = ModuleId;";
    } else if (owner === "react-peer") {
      files["modules/alpha/frontend/src/index.ts"] =
        "import type { ComponentType } from 'react'; export type View = ComponentType;";
    } else if (owner === "tauri") {
      files["modules/alpha/frontend/src/index.ts"] =
        "import { invoke } from '@tauri-apps/api/core'; export { invoke };";
    } else if (owner === "core") {
      files["modules/alpha/frontend/src/index.ts"] =
        "import type { ProjectSettings } from '@shipctl/core/platform'; export type S = ProjectSettings;";
    } else if (owner === "cordis") {
      files["modules/alpha/frontend/src/index.ts"] =
        "import { Context } from 'cordis'; export const context = new Context();";
    } else if (owner === "layman") {
      files["modules/alpha/frontend/src/index.ts"] =
        "import type { LaymanSnapshot } from 'react-layman'; export type S = LaymanSnapshot;";
    } else if (owner === "cross-plugin") {
      files["modules/alpha/frontend/src/index.ts"] =
        "import type { Internal } from '@shipctl/module-beta'; export type S = Internal;";
    } else if (owner === "hidden-tauri") {
      files["modules/alpha/frontend/src/index.ts"] = "export { native } from './barrel.ts';";
      files["modules/alpha/frontend/src/barrel.ts"] = "export { native } from './native.ts';";
      files["modules/alpha/frontend/src/native.ts"] =
        "import { invoke } from '@tauri-apps/api/core'; export const native = invoke;";
    } else {
      files["modules/alpha/frontend/src/index.ts"] =
        "export const native = import('@tauri-apps/api/core');";
    }

    const root = await boundaryFixture(files);
    try {
      const accepted = (await checkModuleBoundaries(root)).length === 0;
      assert.equal(accepted, allowed.has(owner), `resolved owner: ${owner}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }));
});

function lifecycleProvider(reference, labels, trace) {
  return {
    service: reference,
    bind(context) {
      for (const label of labels) context.own(() => { trace.push(label); });
      return Object.freeze({ activationId: context.activation.activationId });
    },
  };
}

test("architecture.plugin-service-fake.property", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.string()), async (labels) => {
    const reference = defineSemanticService("test.lifecycle", 1);
    const productionTrace = [];
    const fakeTrace = [];
    const production = new SemanticServiceRegistry([
      lifecycleProvider(reference, labels, productionTrace),
    ]);
    const fake = new SemanticServiceTestHost([
      lifecycleProvider(reference, labels, fakeTrace),
    ]);
    const productionActivation = production.activate(
      createTestActivationIdentity("test.module", "test.module#production"),
    );
    const fakeActivation = fake.activate(
      createTestActivationIdentity("test.module", "test.module#fake"),
    );
    productionActivation.context.services.require(reference);
    fakeActivation.context.services.require(reference);
    await Promise.all([productionActivation.dispose(), fakeActivation.dispose()]);
    assert.deepEqual(productionTrace, [...labels].reverse());
    assert.deepEqual(fakeTrace, productionTrace);
    assert.equal(productionActivation.context.disposed, true);
    assert.equal(fakeActivation.context.disposed, true);
  }));
});

test("architecture.service-activation.property", async () => {
  const actionArbitrary = fc.array(fc.record({
    activation: fc.nat(),
    value: fc.integer(),
    cancelled: fc.boolean(),
    disposeBefore: fc.boolean(),
  }));
  await fc.assert(fc.asyncProperty(
    fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 1 }),
    actionArbitrary,
    async (activationNames, actions) => {
      const reference = defineSemanticService("test.echo", 1);
      const traces = [];
      const provider = {
        service: reference,
        bind(context) {
          return {
            echo: createFakeRequestOperation({
              context,
              policy: POLICY,
              handle: ({ input }) => input,
              failedError: () => FAILED,
              cancelledError: CANCELLED,
              disposedError: DISPOSED,
              trace: traces,
            }),
          };
        },
      };
      const host = new SemanticServiceTestHost([provider]);
      const activations = activationNames.map((name, index) => host.activate(
        createTestActivationIdentity("test.module", `${name}#${index}`),
      ));
      const operations = activations.map(({ context }) =>
        context.services.require(reference).echo);
      const active = activations.map(() => true);
      const expectedTraces = [];

      for (const action of actions) {
        const index = action.activation % activations.length;
        const activation = activations[index];
        if (action.disposeBefore && active[index]) {
          await activation.dispose();
          active[index] = false;
        }
        const cancellation = new TestCancellation(activation.context);
        if (action.cancelled && active[index]) cancellation.cancel();
        const outcome = await operations[index].execute(action.value, { cancellation });
        if (!active[index]) {
          assert.equal(outcome.result.ok, false);
          assert.equal(outcome.result.error.code, DISPOSED.code);
        } else if (action.cancelled) {
          assert.equal(outcome.result.ok, false);
          assert.equal(outcome.result.error.code, CANCELLED.code);
        } else {
          assert.deepEqual(outcome.result, { ok: true, value: action.value });
          expectedTraces.push({
            activation: activation.context.identity,
            input: action.value,
          });
        }
      }

      assert.deepEqual(
        traces.map(({ activation, input }) => ({ activation, input })),
        expectedTraces,
      );
      for (const activation of activations) await activation.dispose();
      assert.throws(
        () => host.activate(activations[0].context.identity),
        /cannot be reused/,
      );
    },
  ));
});

test("architecture.service-request.service.property", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.record({
      value: fc.integer(),
      active: fc.boolean(),
      cancelled: fc.boolean(),
    })),
    async (actions) => {
      const activation = createTestActivationIdentity("test.module", "test.module#adapter");
      const envelopes = [];
      let nextCorrelation = 0;
      for (const action of actions) {
        const adapter = createSemanticRequestAdapter({
          activation,
          active: () => action.active,
          policy: POLICY,
          transport: {
            async request(envelope) {
              envelopes.push(envelope);
              return { ok: true, value: envelope.input * 2 };
            },
          },
          correlationId: () => `correlation#${nextCorrelation += 1}`,
          transportError: () => FAILED,
          cancelledError: CANCELLED,
          disposedError: DISPOSED,
        });
        const cancellation = {
          cancelled: action.cancelled,
          subscribe: () => { throw new Error("not used for before-dispatch cancellation"); },
        };
        const outcome = await adapter.execute(action.value, { cancellation });
        if (!action.active) assert.equal(outcome.result.error.code, DISPOSED.code);
        else if (action.cancelled) assert.equal(outcome.result.error.code, CANCELLED.code);
        else assert.deepEqual(outcome.result, { ok: true, value: action.value * 2 });
      }
      const dispatched = actions.filter(({ active, cancelled }) => active && !cancelled);
      assert.deepEqual(envelopes.map(({ activation: seen, input }) => ({ seen, input })),
        dispatched.map(({ value }) => ({ seen: activation, input: value })));
      assert.equal(new Set(envelopes.map(({ correlationId }) => correlationId)).size, envelopes.length);
    },
  ));
});

test("architecture.service-event.service.property", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.record({ scope: fc.boolean(), value: fc.integer() })),
    fc.nat(),
    fc.nat(),
    async (events, leftRaw, rightRaw) => {
      const reference = defineSemanticService("test.events", 1);
      let control;
      const provider = {
        service: reference,
        bind(context) {
          control = new TestEventSource(context, "test.events.changed", (left, right) => left === right);
          return { changed: control };
        },
      };
      const host = new SemanticServiceTestHost([provider]);
      const activation = host.activate(createTestActivationIdentity("test.module"));
      const source = activation.context.services.require(reference).changed;
      const received = [[], []];
      const leases = [
        await source.subscribe(false, (event) => { received[0].push(event); }),
        await source.subscribe(true, (event) => { received[1].push(event); }),
      ];
      const cutoffs = [leftRaw % (events.length + 1), rightRaw % (events.length + 1)];
      for (const [index, event] of events.entries()) {
        for (const subscriber of [0, 1]) {
          if (cutoffs[subscriber] === index) await leases[subscriber].dispose();
        }
        await control.publish(event.scope, event.value);
      }
      for (const subscriber of [0, 1]) {
        if (cutoffs[subscriber] === events.length) await leases[subscriber].dispose();
        const scope = subscriber === 1;
        const expected = events.flatMap((event, index) =>
          index < cutoffs[subscriber] && event.scope === scope
            ? [{ sourceId: "test.events.changed", sequence: index + 1, value: event.value }]
            : []);
        assert.deepEqual(received[subscriber], expected);
      }
      await activation.dispose();
      await control.publish(false, 0);
      assert.equal(received[0].length,
        events.filter((event, index) => index < cutoffs[0] && event.scope === false).length);
    },
  ));
});

function drainModel(pending, delivered, state) {
  while (state.credit > 0 && pending.length > 0) {
    state.credit -= 1;
    delivered.push(pending.shift());
  }
}

test("architecture.service-stream.semantic-terminal.property", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.integer()),
    fc.array(fc.integer()),
    fc.nat(),
    fc.nat(),
    fc.nat(),
    fc.nat(),
    async (before, live, retainedRaw, afterRaw, initialRaw, grantRaw) => {
      const reference = defineSemanticService("test.stream", 1);
      let control;
      const retainedCount = retainedRaw % (before.length + live.length + 1);
      const provider = {
        service: reference,
        bind(context) {
          control = new TestOrderedStreamSource(context, retainedCount);
          return { output: control };
        },
      };
      const host = new SemanticServiceTestHost([provider]);
      const activation = host.activate(createTestActivationIdentity("test.module"));
      const stream = activation.context.services.require(reference).output;
      for (const value of before) await control.append(value);

      const afterSequence = afterRaw % (before.length + 1);
      const initialCredit = initialRaw % (before.length + live.length + 1);
      const deliveries = [];
      const attachment = await stream.attach(
        { afterSequence, initialCredit },
        (delivery) => { deliveries.push(delivery); },
      );

      const beforeFrames = before.map((value, index) => ({ sequence: index + 1, value }));
      const retainedBefore = retainedCount === 0
        ? []
        : beforeFrames.slice(-retainedCount);
      const pending = retainedBefore.filter(({ sequence }) => sequence > afterSequence);
      const delivered = [];
      const state = { credit: initialCredit };
      drainModel(pending, delivered, state);
      for (const [index, value] of live.entries()) {
        const frame = { sequence: before.length + index + 1, value };
        pending.push(frame);
        await control.append(value);
        drainModel(pending, delivered, state);
      }
      const grant = grantRaw % (pending.length + 1);
      if (grant > 0) attachment.grant(grant);
      state.credit += grant;
      drainModel(pending, delivered, state);
      await control.settled();

      const currentSequence = before.length + live.length;
      const allFrames = [...before, ...live].map((value, index) => ({ sequence: index + 1, value }));
      const retainedNow = retainedCount === 0 ? [] : allFrames.slice(-retainedCount);
      const earliestBefore = retainedBefore[0]?.sequence ?? before.length + 1;
      const expectedGap = afterSequence < before.length && afterSequence < earliestBefore - 1;
      assert.deepEqual(
        deliveries.filter(({ type }) => type === "gap").length,
        expectedGap ? 1 : 0,
      );
      assert.deepEqual(
        deliveries.filter(({ type }) => type === "frame").map(({ sequence, value }) => ({ sequence, value })),
        delivered,
      );
      const acknowledged = delivered.at(-1)?.sequence ?? null;
      if (acknowledged !== null) attachment.acknowledge(acknowledged);
      assert.equal(attachment.acknowledgedSequence, acknowledged);
      await control.disconnect("test disconnect", true);
      assert.equal(deliveries.at(-1)?.type, "disconnected");

      const replayAfter = acknowledged ?? 0;
      const replay = [];
      const replayAttachment = await stream.attach(
        { afterSequence: replayAfter, initialCredit: retainedNow.length },
        (delivery) => { replay.push(delivery); },
      );
      const earliestNow = retainedNow[0]?.sequence ?? currentSequence + 1;
      const replayGap = replayAfter < currentSequence && replayAfter < earliestNow - 1;
      assert.equal(replay.some(({ type }) => type === "gap"), replayGap);
      assert.deepEqual(
        replay.filter(({ type }) => type === "frame").map(({ sequence, value }) => ({ sequence, value })),
        retainedNow.filter(({ sequence }) => sequence > replayAfter),
      );
      await replayAttachment.dispose();
      await activation.dispose();
    },
  ));
});
