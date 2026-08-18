import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type {
  SemanticTerminalScreenState,
  SemanticTerminalsService,
} from "@shipctl/module-api";
import type {
  SemanticServiceTestHost as SemanticServiceTestHostType,
  createFakeSemanticTerminalScreenState as CreateFakeSemanticTerminalScreenState,
  createTestActivationIdentity as CreateTestActivationIdentity,
} from "@shipctl/module-api/testing";
import { createServer, type ViteDevServer } from "vite";

import type {
  SemanticTerminalsNativeTransport,
  SemanticTerminalsServiceProviderOptions,
} from "../semanticTerminals.ts";

type SemanticTerminalsModule = typeof import("../semanticTerminals.ts");
type ModuleApi = typeof import("@shipctl/module-api");

let vite: ViteDevServer;
let createSemanticTerminalsServiceProvider:
  SemanticTerminalsModule["createSemanticTerminalsServiceProvider"];
let semanticTerminalsService: ModuleApi["semanticTerminalsService"];
let SemanticServiceTestHost: typeof SemanticServiceTestHostType;
let createTestActivationIdentity: typeof CreateTestActivationIdentity;
let createFakeSemanticTerminalScreenState: typeof CreateFakeSemanticTerminalScreenState;

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    server: { middlewareMode: true, hmr: false },
  });
  ({ createSemanticTerminalsServiceProvider } = await vite.ssrLoadModule(
    "/core/frontend/platform/semanticTerminals.ts",
  ) as SemanticTerminalsModule);
  ({ semanticTerminalsService } = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ) as ModuleApi);
  ({
    SemanticServiceTestHost,
    createFakeSemanticTerminalScreenState,
    createTestActivationIdentity,
  } = await vite.ssrLoadModule("/module-api/frontend/src/testing.ts"));
});

after(async () => {
  await vite.close();
});

const MODULE_ID = "fixture.semantic-terminal";
const ACTIVATION_ID = "fixture.semantic-terminal@1#active";
const TERMINAL_ID = "semantic-terminal-one";

function publicationStats() {
  return {
    ptyReads: 1,
    screenChanges: 2,
    screenProjections: 3,
    screenEncodes: 4,
    screenEncodedBytes: 5,
    screenRecipientDeliveries: 6,
    effectEvents: 7,
    effectEncodedBytes: 8,
    currentScreenTransactions: 9,
    currentScreenBytesQueued: 10,
    peakScreenBytesQueued: 11,
    currentEffectEventsQueued: 12,
    currentEffectBytesQueued: 13,
    peakEffectEventsQueued: 14,
    peakEffectBytesQueued: 15,
  };
}

function fixture(options: {
  readonly grants?: readonly string[];
  readonly snapshot?: unknown;
} = {}) {
  const state = createFakeSemanticTerminalScreenState(2, 1);
  const credits: Array<{ attachmentId: string; committedSequence: number }> = [];
  const detached: string[] = [];
  const inputs: unknown[] = [];
  const resizes: unknown[] = [];
  const requests: Array<{ operation: string; activationId: string }> = [];
  let deliver: ((raw: unknown) => void) | null = null;
  const transport: SemanticTerminalsNativeTransport = {
    snapshot: async () => options.snapshot ?? state,
    attach: async (_request, listener) => {
      deliver = listener;
      return {
        attachmentId: "semantic-attachment-one",
        live: true,
        descriptor: { revision: 4 },
        sequenceBoundary: 10,
        snapshot: state,
      };
    },
    creditScreen: async ({ input: { attachmentId, committedSequence } }) => {
      credits.push({ attachmentId, committedSequence });
    },
    detach: async ({ input: { attachmentId } }) => { detached.push(attachmentId); },
    resize: async ({ input: { terminalId, attachmentId, columns, rows } }) => {
      resizes.push({ terminalId, attachmentId, columns, rows });
    },
    input: async ({ input: { input } }) => {
      inputs.push(input);
      const text = input.kind === "key" ? input.text ?? "" : "text" in input ? input.text : "";
      return new TextEncoder().encode(text).length;
    },
    history: async () => ({ startRow: 0, historyRows: 1, rows: [{
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
    }] }),
    anchor: async ({ input: { at } }) => ({
      id: 9,
      retained: true,
      lossReported: false,
      history: at,
      screen: null,
      viewport: null,
      active: null,
    }),
    resolveAnchor: async () => null,
    releaseAnchor: async () => true,
    select: async () => ({ active: true, text: "$" }),
    inspectPaste: async ({ input: { text } }) => !/[\r\n]/u.test(text),
    publicationStats: async () => publicationStats(),
    appMemory: async () => ({ appRss: 4096 }),
    releaseActivation: async () => 0,
  };
  const identity = createTestActivationIdentity(MODULE_ID, ACTIVATION_ID);
  const bindingsByActivation: SemanticTerminalsServiceProviderOptions["bindingsByActivation"] =
    new Map([[ACTIVATION_ID, {
      moduleId: MODULE_ID,
      activationId: ACTIVATION_ID,
      grants: new Set(options.grants ?? [
        "semantic-terminal.attach",
        "semantic-terminal.input",
        "semantic-terminal.inspect",
      ]),
    }]]);
  const provider = createSemanticTerminalsServiceProvider({
    bindingsByActivation,
    transport,
    observeRequest: (operation, envelope) => {
      requests.push({ operation, activationId: envelope.activation.activationId });
    },
  });
  const activation = new SemanticServiceTestHost([provider]).activate(identity);
  const service: SemanticTerminalsService = activation.context.services.require(
    semanticTerminalsService,
  );
  return {
    activation,
    credits,
    detached,
    emit(raw: unknown) { deliver?.(raw); },
    inputs,
    requests,
    resizes,
    service,
    state,
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("semantic-terminal adapter attaches without owning the original terminal session", async () => {
  const current = fixture();
  const delivery = [];
  const attachment = await current.service.screens.attach({
    terminalId: TERMINAL_ID as never,
    claimsResize: true,
    afterSequence: null,
    initialCredit: 0,
  }, (value) => { delivery.push(value); });

  const input = await current.service.input.execute({
    terminalId: TERMINAL_ID as never,
    input: { kind: "text", text: "żółw" },
  });
  const history = await current.service.history.execute({
    terminalId: TERMINAL_ID as never,
    startRow: 0,
    rows: 1,
  });
  const anchor = await current.service.createAnchor.execute({
    terminalId: TERMINAL_ID as never,
    space: "history",
    at: { column: 2, row: 3 },
  });
  const selection = await current.service.select.execute({
    terminalId: TERMINAL_ID as never,
    request: { kind: "all" },
  });
  const paste = await current.service.inspectPaste.execute({ text: "one\ntwo" });
  const stats = await current.service.publicationStats.execute({
    terminalId: TERMINAL_ID as never,
  });
  const memory = await current.service.appMemory.execute({});
  const resize = await current.service.resize.execute({
    terminalId: TERMINAL_ID as never,
    attachmentId: attachment.id as never,
    columns: 120,
    rows: 40,
  });

  assert.equal(input.result.ok && input.result.value.encodedBytes, 7);
  assert.equal(history.result.ok && history.result.value.rows[0]?.cells[0]?.text, "$");
  assert.deepEqual(anchor.result.ok && anchor.result.value.history, { column: 2, row: 3 });
  assert.equal(selection.result.ok && selection.result.value.text, "$");
  assert.equal(paste.result.ok && paste.result.value.safe, false);
  assert.equal(stats.result.ok && stats.result.value.effectEvents, 7);
  assert.equal(memory.result.ok && memory.result.value.appRss, 4096);
  assert.equal(resize.result.ok, true);
  assert.deepEqual(current.requests.map(({ operation }) => operation), [
    "input",
    "history",
    "create-anchor",
    "select",
    "inspect-paste",
    "publication-stats",
    "app-memory",
    "resize",
  ]);
  assert.ok(current.requests.every(({ activationId }) => activationId === ACTIVATION_ID));
  await current.activation.dispose();
});

test("semantic-terminal adapter maps native flow control to revision flow control", async () => {
  const current = fixture();
  const deliveries: unknown[] = [];
  const attachment = await current.service.screens.attach({
    terminalId: TERMINAL_ID as never,
    claimsResize: true,
    afterSequence: null,
    initialCredit: 0,
  }, (delivery) => { deliveries.push(delivery); });

  assert.equal(attachment.active, false);
  assert.equal(attachment.snapshot.revision, 4);
  attachment.activate();
  current.emit({ event: "effects", sequence: 11, effects: [{ kind: "bell" }] });
  assert.deepEqual(current.credits, []);
  attachment.grant(1);
  await settle();
  assert.deepEqual(current.credits, [{
    attachmentId: "semantic-attachment-one",
    committedSequence: 10,
  }]);

  const nextState: SemanticTerminalScreenState = {
    ...current.state,
    cursor: { ...current.state.cursor, column: 1 },
  };
  current.emit({ event: "screen", sequence: 12, revision: 5, state: nextState });
  await settle();
  assert.deepEqual(deliveries, [{
    type: "frame",
    attachmentId: attachment.id,
    sequence: 5,
    value: { revision: 5, state: nextState, effects: [{ kind: "bell" }] },
  }]);

  attachment.acknowledge(5);
  attachment.grant(1);
  await settle();
  assert.deepEqual(current.credits.at(-1), {
    attachmentId: "semantic-attachment-one",
    committedSequence: 12,
  });
  await current.activation.dispose();
  assert.equal(attachment.disposed, true);
  assert.deepEqual(current.detached, ["semantic-attachment-one"]);
});

test("semantic-terminal adapter rejects malformed native values and missing authority", async () => {
  const malformed = fixture({ snapshot: { rows: [] } });
  const snapshot = await malformed.service.snapshot.execute({
    terminalId: TERMINAL_ID as never,
  });
  assert.equal(snapshot.result.ok, false);
  assert.equal(snapshot.result.ok ? null : snapshot.result.error.code,
    "semantic-terminals.protocol.failed");
  await malformed.activation.dispose();

  const denied = fixture({ grants: ["semantic-terminal.inspect"] });
  const input = await denied.service.input.execute({
    terminalId: TERMINAL_ID as never,
    input: { kind: "text", text: "blocked" },
  });
  assert.equal(input.result.ok, false);
  assert.equal(input.result.ok ? null : input.result.error.code,
    "semantic-terminals.activation.denied");
  assert.deepEqual(denied.inputs, []);
  await assert.rejects(() => denied.service.screens.attach({
    terminalId: TERMINAL_ID as never,
    claimsResize: false,
    afterSequence: null,
    initialCredit: 0,
  }, () => undefined));
  await denied.activation.dispose();
});
