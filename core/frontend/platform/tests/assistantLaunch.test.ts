import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type {
  AssistantLaunchService,
} from "@shipctl/module-api";
import type {
  SemanticServiceTestHost as SemanticServiceTestHostType,
  createTestActivationIdentity as CreateTestActivationIdentity,
} from "@shipctl/module-api/testing";
import { createServer, type ViteDevServer } from "vite";

import type {
  NativeAssistantLaunchTransport,
} from "../assistantLaunch.ts";

type AssistantLaunchModule = typeof import("../assistantLaunch.ts");
type ModuleApi = typeof import("@shipctl/module-api");

let vite: ViteDevServer;
let createAssistantLaunchServiceProvider:
  AssistantLaunchModule["createAssistantLaunchServiceProvider"];
let assistantLaunchService: ModuleApi["assistantLaunchService"];
let SemanticServiceTestHost: typeof SemanticServiceTestHostType;
let createTestActivationIdentity: typeof CreateTestActivationIdentity;

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    server: { middlewareMode: true, hmr: false },
  });
  ({ createAssistantLaunchServiceProvider } = await vite.ssrLoadModule(
    "/core/frontend/platform/assistantLaunch.ts",
  ) as AssistantLaunchModule);
  ({ assistantLaunchService } = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ) as ModuleApi);
  ({ SemanticServiceTestHost, createTestActivationIdentity } = await vite.ssrLoadModule(
    "/module-api/frontend/src/testing.ts",
  ));
});

after(async () => {
  await vite.close();
});

test("assistant-launch adapter preserves a structured native failure message", async () => {
  const unused = async (): Promise<never> => { throw new Error("not used"); };
  const transport: NativeAssistantLaunchTransport = {
    startSession: unused,
    resumeSession: unused,
    recordSessionIdentity: unused,
    markSessionIdentityFailed: unused,
    recordSessionPlacement: unused,
    recordSessionLabel: unused,
    discardSession: unused,
    rearmSession: unused,
    inspectRestorableSessions: unused,
    takeStartupWarning: unused,
    prepareForShutdown: unused,
    readResource: async () => {
      throw Object.assign(
        new Error("Assistant resource tree exceeds its declared file bound"),
        { code: "assistant-launch.transport-failed" },
      );
    },
    writeResource: unused,
    executeResource: unused,
    releaseActivation: async () => true,
  };
  const provider = createAssistantLaunchServiceProvider({
    transport,
    authorize: () => true,
  });
  const host = new SemanticServiceTestHost([provider]);
  const activation = host.activate(createTestActivationIdentity(
    "shipctl.fixture-assistant",
    "shipctl.fixture-assistant@digest#one",
  ));
  const service: AssistantLaunchService = activation.context.services.require(
    assistantLaunchService,
  );
  const outcome = await service.readResource.execute({
    request: {
      kind: "tree",
      resourceId: "fixture",
      relativePath: ".fixture",
      maxFiles: 1,
    },
  });

  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.result.error.code, "assistant-launch.transport-failed");
  assert.equal(
    outcome.result.error.message,
    "Assistant resource tree exceeds its declared file bound",
  );
  await activation.dispose();
});
