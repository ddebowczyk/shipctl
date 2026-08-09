import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer, type ViteDevServer } from "vite";

import type { HostMessageFrame } from "../runtimeMessages.ts";

type RuntimeMessagesModule = typeof import("../runtimeMessages.ts");

let vite: ViteDevServer;
let createRuntimeMessageTransport: RuntimeMessagesModule["createRuntimeMessageTransport"];

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    server: { middlewareMode: true, hmr: false },
  });
  ({ createRuntimeMessageTransport } = await vite.ssrLoadModule(
    "/core/frontend/platform/runtimeMessages.ts",
  ) as RuntimeMessagesModule);
});

after(async () => {
  await vite.close();
});

test("runtime message transport owns the sole Tauri command and Channel mapping", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const channel = { onmessage: null as ((frame: HostMessageFrame) => void) | null };
  const transport = createRuntimeMessageTransport(
    async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return { bridgeId: "fixture" } as T;
    },
    () => channel,
  );
  const onFrame = () => undefined;

  await transport.open([], onFrame);
  await transport.reconcile("fixture", 7, []);
  await transport.close("fixture");
  await transport.reply("fixture", { correlationId: "reply", error: { code: "x", message: "y" } });
  await transport.reportFailure("fixture", "fixture@digest#one", "fixture.events", "message.handler.failed");

  assert.equal(channel.onmessage, onFrame);
  assert.deepEqual(calls.map(({ command }) => command), [
    "open_runtime_message_bridge",
    "reconcile_runtime_message_bridge",
    "close_runtime_message_bridge",
    "reply_runtime_message",
    "report_runtime_message_failure",
  ]);
  assert.equal(calls[0]?.args?.onFrame, channel);
  assert.deepEqual(calls[4]?.args, {
    bridgeId: "fixture",
    activationId: "fixture@digest#one",
    endpoint: "fixture.events",
    code: "message.handler.failed",
  });
});
