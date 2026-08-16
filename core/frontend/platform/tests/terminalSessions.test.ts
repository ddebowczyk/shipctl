import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type {
  ModuleTerminalSession,
  RawTerminalOccurrence,
  TerminalHostPort,
  TerminalSessionsService,
} from "@shipctl/module-api";
import type {
  SemanticServiceTestHost as SemanticServiceTestHostType,
  TestCancellation as TestCancellationType,
  createTestActivationIdentity as CreateTestActivationIdentity,
} from "@shipctl/module-api/testing";
import { createServer, type ViteDevServer } from "vite";

import type {
  TerminalSessionsServiceProviderOptions,
} from "../terminalSessions.ts";
import type {
  ActivationTerminalSessionsRuntime,
} from "@shipctl/core/terminal-host";

type TerminalSessionsModule = typeof import("../terminalSessions.ts");
type ModuleApi = typeof import("@shipctl/module-api");

let vite: ViteDevServer;
let createTerminalSessionsServiceProvider:
  TerminalSessionsModule["createTerminalSessionsServiceProvider"];
let terminalDriverId: ModuleApi["terminalDriverId"];
let terminalSessionsService: ModuleApi["terminalSessionsService"];
let SemanticServiceTestHost: typeof SemanticServiceTestHostType;
let TestCancellation: typeof TestCancellationType;
let createTestActivationIdentity: typeof CreateTestActivationIdentity;

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    server: { middlewareMode: true, hmr: false },
  });
  ({ createTerminalSessionsServiceProvider } = await vite.ssrLoadModule(
    "/core/frontend/platform/terminalSessions.ts",
  ) as TerminalSessionsModule);
  ({ terminalDriverId, terminalSessionsService } = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ) as ModuleApi);
  ({
    SemanticServiceTestHost,
    TestCancellation,
    createTestActivationIdentity,
  } = await vite.ssrLoadModule("/module-api/frontend/src/testing.ts"));
});

after(async () => {
  await vite.close();
});

const MODULE_ID = "shipctl.fixture-terminal";
const ACTIVATION_ID = "shipctl.fixture-terminal@digest#one";
const TERMINAL_ID = "terminal-one";
const SESSION_ID = "session-one";

class OccurrenceQueue implements AsyncIterable<RawTerminalOccurrence> {
  readonly #queued: RawTerminalOccurrence[] = [];
  #waiting: ((result: IteratorResult<RawTerminalOccurrence>) => void) | null = null;
  #closed = false;

  push(value: RawTerminalOccurrence): void {
    const waiting = this.#waiting;
    this.#waiting = null;
    if (waiting) waiting({ done: false, value });
    else this.#queued.push(value);
  }

  close(): void {
    this.#closed = true;
    const waiting = this.#waiting;
    this.#waiting = null;
    waiting?.({ done: true, value: undefined });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<RawTerminalOccurrence> {
    while (true) {
      const queued = this.#queued.shift();
      if (queued) {
        yield queued;
        continue;
      }
      if (this.#closed) return;
      const next = await new Promise<IteratorResult<RawTerminalOccurrence>>((resolve) => {
        this.#waiting = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

function session(): ModuleTerminalSession {
  return {
    id: SESSION_ID as never,
    terminalId: TERMINAL_ID as never,
    moduleId: MODULE_ID,
    projectPath: "/workspace",
    ownerKey: "fixture:terminal",
    label: "Fixture terminal",
  };
}

function fixture(grants = [
  "terminal.start",
  "terminal.attach",
  "terminal.input",
  "terminal.resize",
  "terminal.stop",
]) {
  const queue = new OccurrenceQueue();
  const writes: number[] = [];
  const resizes: Array<{ attachmentId: string; columns: number; rows: number }> = [];
  const detached: string[] = [];
  let releaseFirstWrite: (() => void) | null = null;
  const firstWriteBlocked = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
  let lifecycleListener: Parameters<ActivationTerminalSessionsRuntime["subscribe"]>[1] | null = null;
  const runtime: ActivationTerminalSessionsRuntime = {
    getDimensions: () => ({ columns: 80, rows: 24 }),
    list: () => [session()],
    launch: async () => session(),
    update: async () => session(),
    focus: async () => session(),
    stop: async () => session(),
    subscribe(_moduleId, listener) {
      lifecycleListener = listener;
      return () => { lifecycleListener = null; };
    },
  };
  const host: TerminalHostPort = {
    list: async () => [],
    launch: async () => { throw new Error("not used"); },
    observe: async () => () => undefined,
    attachRaw: async (terminalId, driverId) => ({
      id: "attachment-one",
      terminalId,
      driverId,
      sequenceBoundary: 4,
      occurrences: queue,
      detach: async () => {
        detached.push("attachment-one");
        queue.close();
      },
    }),
    async write(_terminalId, bytes) {
      if (bytes[0] === 1) await firstWriteBlocked;
      writes.push(bytes[0] ?? -1);
    },
    async resize(_terminalId, attachmentId, columns, rows) {
      resizes.push({ attachmentId, columns, rows });
    },
    close: async () => undefined,
  };
  const observed: Array<{ operation: string; request: unknown }> = [];
  let correlation = 0;
  const bindingsByActivation: TerminalSessionsServiceProviderOptions["bindingsByActivation"] =
    new Map([[ACTIVATION_ID, {
      moduleId: MODULE_ID as never,
      activationId: ACTIVATION_ID,
      grants: new Set(grants),
    }]]);
  const provider = createTerminalSessionsServiceProvider({
    bindingsByActivation,
    runtime,
    terminalHost: host,
    correlationId: () => `terminal-request-${correlation += 1}` as never,
    observeRequest: (operation, request) => { observed.push({ operation, request }); },
  });
  const serviceHost = new SemanticServiceTestHost([provider]);
  const activation = serviceHost.activate(
    createTestActivationIdentity(MODULE_ID, ACTIVATION_ID),
  );
  const service: TerminalSessionsService = activation.context.services.require(
    terminalSessionsService,
  );
  return {
    activation,
    detached,
    emitLifecycle: async () => lifecycleListener?.({ type: "updated", session: session() }),
    observed,
    queue,
    releaseFirstWrite: () => releaseFirstWrite?.(),
    resizes,
    service,
    writes,
  };
}

async function settled(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("terminal-session adapter preserves attribution, request order, and cancellation", async () => {
  const current = fixture();
  const cancelled = new TestCancellation(current.activation.context);
  cancelled.cancel();
  const cancelledWrite = await current.service.writeInput.execute({
    terminalId: TERMINAL_ID,
    attachmentId: "attachment-one",
    source: "key",
    bytes: new Uint8Array([9]),
  }, { cancellation: cancelled });
  assert.equal(cancelledWrite.result.ok, false);
  assert.equal(cancelledWrite.result.error.code, "terminal-sessions.request.cancelled");

  const attachment = await current.service.bytes.attach({
    terminalId: TERMINAL_ID,
    driverId: terminalDriverId("thin-terminal"),
    claimsResize: false,
    afterSequence: null,
    initialCredit: 0,
  }, () => undefined);
  const first = current.service.writeInput.execute({
    terminalId: TERMINAL_ID,
    attachmentId: attachment.id,
    source: "key",
    bytes: new Uint8Array([1]),
  });
  const second = current.service.writeInput.execute({
    terminalId: TERMINAL_ID,
    attachmentId: attachment.id,
    source: "paste",
    bytes: new Uint8Array([2]),
  });
  await settled();
  assert.deepEqual(current.writes, []);
  current.releaseFirstWrite();
  assert.equal((await first).result.ok, true);
  assert.equal((await second).result.ok, true);
  assert.deepEqual(current.writes, [1, 2]);
  assert.deepEqual(current.observed.map(({ operation }) => operation), ["input", "input"]);
  for (const { request } of current.observed) {
    const envelope = request as { activation: { moduleId: string; activationId: string } };
    assert.deepEqual(envelope.activation, {
      moduleId: MODULE_ID,
      activationId: ACTIVATION_ID,
    });
  }
  await current.activation.dispose();
});

test("terminal-session adapter enforces credit, resize ownership, and disposal", async () => {
  const current = fixture();
  const deliveries: Array<{ readonly type: string; readonly sequence?: number }> = [];
  const attachment = await current.service.bytes.attach({
    terminalId: TERMINAL_ID,
    driverId: terminalDriverId("thin-terminal"),
    claimsResize: true,
    afterSequence: 2,
    initialCredit: 1,
  }, (delivery) => { deliveries.push(delivery); });
  assert.deepEqual(deliveries.map(({ type }) => type), ["gap"]);

  current.queue.push({ sequence: 5, bytes: new Uint8Array([5]) });
  current.queue.push({ sequence: 6, bytes: new Uint8Array([6]) });
  await settled();
  assert.deepEqual(deliveries.map(({ sequence }) => sequence), [undefined, 5]);
  attachment.acknowledge(5);
  attachment.grant(1);
  await settled();
  assert.deepEqual(deliveries.map(({ sequence }) => sequence), [undefined, 5, 6]);

  const resized = await current.service.resize.execute({
    terminalId: TERMINAL_ID,
    attachmentId: attachment.id,
    columns: 120,
    rows: 40,
  });
  assert.equal(resized.result.ok, true);
  assert.deepEqual(current.resizes, [{
    attachmentId: "attachment-one",
    columns: 120,
    rows: 40,
  }]);
  const forgedResize = await current.service.resize.execute({
    terminalId: TERMINAL_ID,
    attachmentId: "forged",
    columns: 120,
    rows: 40,
  });
  assert.equal(forgedResize.result.ok, false);
  assert.equal(forgedResize.result.error.code, "terminal-sessions.activation.denied");

  await current.activation.dispose();
  assert.equal(attachment.disposed, true);
  assert.deepEqual(current.detached, ["attachment-one"]);
});

test("terminal-session adapter orders lifecycle events and denies absent grants", async () => {
  const current = fixture(["terminal.attach"]);
  const observed: number[] = [];
  let releaseFirst: (() => void) | null = null;
  const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  await current.service.lifecycle.subscribe({ owner: "activation" }, async (event) => {
    if (event.sequence === 1) await blocked;
    observed.push(event.sequence);
  });
  const first = current.emitLifecycle();
  const second = current.emitLifecycle();
  await settled();
  assert.deepEqual(observed, []);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(observed, [1, 2]);

  const denied = await current.service.writeInput.execute({
    terminalId: TERMINAL_ID,
    attachmentId: "attachment-one",
    source: "key",
    bytes: new Uint8Array([1]),
  });
  assert.equal(denied.result.ok, false);
  assert.equal(denied.result.error.code, "terminal-sessions.activation.denied");
  await current.activation.dispose();
});
