import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";

import type { CanvasActions, CanvasModel, CanvasPorts } from "../types.ts";
import type { CanvasAdapterView } from "../adapterTypes.ts";

type CanvasHostModule = typeof import("../CanvasHost.tsx");
type CanvasAdapterResolverModule = typeof import("../canvasAdapterResolver.tsx");
type LegacyCanvasModule = typeof import("../legacy/LegacyCanvas.tsx");
type LaymanCanvasModule = typeof import("../layman/LaymanCanvas.tsx");

let vite: ViteDevServer;
let CanvasHost: CanvasHostModule["default"];
let resolveCanvasAdapter: CanvasAdapterResolverModule["resolveCanvasAdapter"];
let LegacyCanvas: LegacyCanvasModule["default"];
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
  ({ default: LegacyCanvas } = await vite.ssrLoadModule(
    "/core/frontend/canvas/legacy/LegacyCanvas.tsx",
  ) as LegacyCanvasModule);
  ({ default: LaymanCanvas } = await vite.ssrLoadModule(
    "/core/frontend/canvas/layman/LaymanCanvas.tsx",
  ) as LaymanCanvasModule);
});

after(async () => {
  await vite.close();
});

test("resolves exactly one bundled canvas adapter for each typed selection", () => {
  assert.strictEqual(resolveCanvasAdapter("legacy"), LegacyCanvas);
  assert.strictEqual(resolveCanvasAdapter("layman"), LaymanCanvas);
});

test("rejects a configured adapter that the current build did not register", () => {
  assert.throws(
    () => resolveCanvasAdapter("layman", { legacy: LegacyCanvas }),
    /Canvas adapter "layman" is not available/,
  );
});

test("CanvasHost renders only the component fixed by bootstrap", () => {
  const requests: CanvasModel[] = [];
  const BootstrapAdapter: CanvasAdapterView = ({ model }) => {
    requests.push(model);
    return createElement("main", { "data-canvas-adapter": "bootstrap-fixture" });
  };
  const model = {} as CanvasModel;

  const html = renderToStaticMarkup(createElement(CanvasHost, {
    adapter: BootstrapAdapter,
    model,
    actions: {} as CanvasActions,
    ports: {} as CanvasPorts,
  }));

  assert.match(html, /data-canvas-adapter="bootstrap-fixture"/);
  assert.deepEqual(requests, [model]);
});

test("startup resolves host configuration before it mounts AppShell", async () => {
  const source = await readFile("src/main.tsx", "utf8");
  const appShell = await readFile("core/frontend/shell/AppShell.tsx", "utf8");

  assert.match(source, /const canvasAdapterId = await getCanvasAdapter\(\)/);
  assert.match(source, /const canvasAdapter = bindCanvasAdapterRuntime\(/);
  assert.match(source, /resolveCanvasAdapter\(canvasAdapterId\)/);
  assert.match(source, /<App canvasAdapter=\{canvasAdapter\} canvasAdapterId=\{canvasAdapterId\}/);
  assert.match(appShell, /<CanvasHost\s+adapter=\{canvasAdapter\}/);
  assert.match(appShell, /TERMINAL_CLIENT_RUNTIME\.startRegistry\(\)/);
});
