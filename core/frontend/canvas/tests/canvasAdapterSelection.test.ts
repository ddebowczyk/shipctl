import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";

import type { WorkspaceCanvas } from "@shipctl/core/workspace";
import type { CanvasAdapterView } from "../adapterTypes.ts";

type CanvasHostModule = typeof import("../CanvasHost.tsx");
type CanvasAdapterResolverModule = typeof import("../canvasAdapterResolver.tsx");
type StandardWorkspaceCanvasModule = typeof import("../standard/StandardWorkspaceCanvas.tsx");
type LaymanCanvasModule = typeof import("../layman/LaymanCanvas.tsx");

let vite: ViteDevServer;
let CanvasHost: CanvasHostModule["default"];
let resolveCanvasAdapter: CanvasAdapterResolverModule["resolveCanvasAdapter"];
let StandardWorkspaceCanvas: StandardWorkspaceCanvasModule["default"];
let LaymanCanvas: LaymanCanvasModule["default"];

before(async () => {
  vite = await createServer({
    server: { hmr: false, middlewareMode: true },
    appType: "custom",
  });
  ({ default: CanvasHost } = await vite.ssrLoadModule(
    "/core/frontend/canvas/CanvasHost.tsx",
  ) as CanvasHostModule);
  ({ resolveCanvasAdapter } = await vite.ssrLoadModule(
    "/core/frontend/canvas/canvasAdapterResolver.tsx",
  ) as CanvasAdapterResolverModule);
  ({ default: StandardWorkspaceCanvas } = await vite.ssrLoadModule(
    "/core/frontend/canvas/standard/StandardWorkspaceCanvas.tsx",
  ) as StandardWorkspaceCanvasModule);
  ({ default: LaymanCanvas } = await vite.ssrLoadModule(
    "/core/frontend/canvas/layman/LaymanCanvas.tsx",
  ) as LaymanCanvasModule);
});

after(async () => {
  await vite.close();
});

test("resolves exactly one bundled canvas adapter for each typed selection", () => {
  assert.strictEqual(resolveCanvasAdapter("standard"), StandardWorkspaceCanvas);
  assert.strictEqual(resolveCanvasAdapter("layman"), LaymanCanvas);
});

test("rejects a configured adapter that the current build did not register", () => {
  assert.throws(
    () => resolveCanvasAdapter("layman", { standard: StandardWorkspaceCanvas }),
    /Canvas adapter "layman" is not available/,
  );
});

test("CanvasHost renders only the component fixed by bootstrap", () => {
  const requests: WorkspaceCanvas[] = [];
  const BootstrapAdapter: CanvasAdapterView = ({ workspace }) => {
    if (workspace) {
      requests.push(workspace);
    }
    return createElement("main", { "data-canvas-adapter": "bootstrap-fixture" });
  };
  const workspace = {} as WorkspaceCanvas;

  const html = renderToStaticMarkup(createElement(CanvasHost, {
    adapter: BootstrapAdapter,
    workspace,
  }));

  assert.match(html, /data-canvas-adapter="bootstrap-fixture"/);
  assert.deepEqual(requests, [workspace]);
});

test("startup renders with the TypeScript default before configuration resolves", async () => {
  const source = await readFile("src/main.tsx", "utf8");
  const app = await readFile("core/frontend/shell/App.tsx", "utf8");
  const appShell = await readFile("core/frontend/shell/AppShell.tsx", "utf8");

  assert.doesNotMatch(source, /getCanvasAdapter|invoke\(/);
  assert.match(source, /<App\s*\/>/);
  assert.match(app, /DEFAULT_RUNTIME_SETTINGS\.canvasAdapter/);
  assert.match(app, /hostConfigurationRuntime\(\)\.resolve\("runtime"\)/);
  assert.match(app, /useEffect\(/);
  assert.match(appShell, /<CanvasHost adapter=\{canvasAdapter\} workspace=\{workspaceCanvas\}/);
  assert.doesNotMatch(appShell, /createCanvasModel|CanvasActions|CanvasPorts/);
  assert.match(appShell, /TERMINAL_CLIENT_RUNTIME\.startRegistry\(\)/);
});
