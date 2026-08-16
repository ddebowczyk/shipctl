import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkModuleBoundaries, formatDiagnostics } from "../bin/check-module-boundaries.mjs";

async function fixture(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "shipctl-module-boundaries-"));
  await mkdir(path.join(root, "core/frontend/host"), { recursive: true });
  await writeFile(
    path.join(root, "core/frontend/package.json"),
    JSON.stringify({
      name: "@shipctl/core",
      exports: {
        "./platform": "./platform/index.ts",
        "./shared": "./shared/index.ts",
        "./alpha": "./alpha/index.ts",
      },
    }),
  );
  for (const [relativeRoot, packageName] of [
    ["module-api/frontend", "@shipctl/module-api"],
    ["modules/alpha/frontend", "@shipctl/alpha"],
    ["modules/beta/frontend", "@shipctl/beta"],
    ["modules/git/frontend", "@shipctl/module-git"],
  ]) {
    const frontend = path.join(root, relativeRoot);
    await mkdir(path.join(frontend, "src"), { recursive: true });
    await writeFile(path.join(frontend, "package.json"), JSON.stringify({
      name: packageName,
      exports: { ".": "./src/index.ts" },
    }));
  }
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}

test("accepts public composition and inward API imports", async (t) => {
  const root = await fixture({
    "core/frontend/host/enabledModules.ts": "import alpha from '@shipctl/alpha'; export default alpha;",
    "src/main.tsx": "import type { ShipctlModule } from '@shipctl/module-api'; export type T = ShipctlModule;",
    "modules/alpha/frontend/src/index.ts": "import type { ShipctlModule } from '@shipctl/module-api'; export const value: ShipctlModule | null = null;",
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await checkModuleBoundaries(root), []);
});

test("rejects observable work in a module public entrypoint", async (t) => {
  const root = await fixture({
    "modules/alpha/frontend/src/index.ts": [
      "import { readFileSync } from 'node:fs';",
      "readFileSync(new URL(import.meta.url));",
      "setTimeout(() => undefined, 0);",
      "globalThis.registry.register('alpha');",
      "globalThis.__TAURI_INTERNALS__.invoke('alpha');",
    ].join("\n"),
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(
    (await checkModuleBoundaries(root)).map(({ rule, specifier }) => ({ rule, specifier })),
    [
      { rule: "module-entrypoint-side-effect", specifier: "node:fs" },
      { rule: "module-entrypoint-side-effect", specifier: "setTimeout" },
      { rule: "module-entrypoint-side-effect", specifier: "globalThis.registry.register" },
      { rule: "module-entrypoint-side-effect", specifier: "globalThis.__TAURI_INTERNALS__.invoke" },
    ],
  );
});

test("rejects observable work in the static entrypoint dependency closure", async (t) => {
  const root = await fixture({
    "modules/alpha/frontend/src/index.ts": "export { value } from './runtime';",
    "modules/alpha/frontend/src/runtime.ts": "setInterval(() => undefined, 1); export const value = 1;",
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(
    (await checkModuleBoundaries(root)).map(({ file, rule, specifier }) => ({
      file,
      rule,
      specifier,
    })),
    [{
      file: "modules/alpha/frontend/src/runtime.ts",
      rule: "module-entrypoint-side-effect",
      specifier: "setInterval",
    }],
  );
});

test("discovers the top-level shared contract package", async (t) => {
  const root = await fixture({
    "module-api/frontend/src/index.ts": "import host from '../../../src/main'; export default host;",
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(
    (await checkModuleBoundaries(root)).map(({ rule }) => rule),
    ["module-host-import"],
  );
});

test("requires modules to use the shared contract public root", async (t) => {
  const root = await fixture({
    "modules/alpha/frontend/src/index.ts": "import type { ModuleId } from '@shipctl/module-api/protocol'; export type T = ModuleId;",
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(
    (await checkModuleBoundaries(root)).map(({ rule }) => rule),
    ["module-api-deep-import"],
  );
});

test("reports deterministic host and sibling violations", async (t) => {
  const root = await fixture({
    "src/main.tsx": "import alpha from '@shipctl/alpha'; export default alpha;",
    "core/frontend/host/enabledModules.ts": "import x from '@shipctl/alpha/src/internal'; export default x;",
    "modules/alpha/frontend/src/index.ts": "import beta from '@shipctl/beta'; export default beta;",
    "modules/beta/frontend/src/index.ts": "import host from '../../../../src/main'; export default host;",
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const diagnostics = await checkModuleBoundaries(root);
  assert.deepEqual(
    diagnostics.map(({ rule }) => rule),
    [
      "host-module-deep-import",
      "module-sibling-import",
      "module-host-import",
      "host-module-import-outside-composition",
    ],
  );
  assert.match(formatDiagnostics(diagnostics), /src\/main\.tsx:1:\d+ \[host-module-import-outside-composition\]/);
});

test("rejects a cross-capability deep import probe", async (t) => {
  const root = await fixture({
    "core/frontend/alpha/index.ts": "export const value = 1;",
    "core/frontend/alpha/internal.ts": "export const secret = 1;",
    "core/frontend/beta/probe.ts": "import { secret } from '../alpha/internal.ts'; export { secret };",
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const diagnostics = await checkModuleBoundaries(root);
  assert.deepEqual(diagnostics.map(({ rule }) => rule), ["core-capability-deep-import"]);
  assert.match(formatDiagnostics(diagnostics), /core\/frontend\/beta\/probe\.ts:1:\d+/);
});

test("rejects capability code in src and application imports into ops", async (t) => {
  const root = await fixture({
    "src/main.tsx": "import '../ops/release.ts';",
    "src/vite-env.d.ts": "/// <reference types='vite/client' />",
    "src/leftover.ts": "export const leftover = true;",
    "modules/alpha/frontend/src/index.ts": "import '../../../../ops/release.ts';",
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const diagnostics = await checkModuleBoundaries(root);
  assert.deepEqual(
    diagnostics.map(({ rule }) => rule),
    ["app-ops-import", "src-entry-only", "app-ops-import"],
  );
});

test("freezes classified legacy listeners and rejects new direct event imports", async (t) => {
  const root = await fixture({
    "modules/git/frontend/src/index.ts": "import { emit, listen } from '@tauri-apps/api/event'; listen('git-fs-changed', () => undefined); emit('module-escape');",
    "modules/alpha/frontend/src/index.ts": "import { listen } from '@tauri-apps/api/event'; listen('usage-ingest-complete', () => undefined);",
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const diagnostics = await checkModuleBoundaries(root);
  assert.deepEqual(diagnostics.map(({ rule, specifier }) => ({ rule, specifier })), [{
    rule: "tauri-import-outside-platform",
    specifier: "@tauri-apps/api/event",
  }, {
    rule: "module-entrypoint-side-effect",
    specifier: "@tauri-apps/api/event",
  }, {
    rule: "module-direct-tauri-event",
    specifier: "usage-ingest-complete",
  }, {
    rule: "tauri-import-outside-platform",
    specifier: "@tauri-apps/api/event",
  }, {
    rule: "module-entrypoint-side-effect",
    specifier: "@tauri-apps/api/event",
  }, {
    rule: "module-entrypoint-side-effect",
    specifier: "@tauri-apps/api/event",
  }, {
    rule: "module-direct-tauri-event",
    specifier: "@tauri-apps/api/event#emit",
  }]);
});

test("rejects Tauri behind a barrel and Layman in module source", async (t) => {
  const root = await fixture({
    "modules/alpha/frontend/src/index.ts": "export { native } from './barrel.ts';",
    "modules/alpha/frontend/src/barrel.ts": "export { native } from './native.ts';",
    "modules/alpha/frontend/src/native.ts": [
      "import { invoke } from '@tauri-apps/api/core';",
      "import { Layman } from 'react-layman';",
      "export const native = [invoke, Layman];",
    ].join("\n"),
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(
    (await checkModuleBoundaries(root)).map(({ file, rule }) => ({ file, rule })),
    [{
      file: "modules/alpha/frontend/src/native.ts",
      rule: "tauri-import-outside-platform",
    }, {
      file: "modules/alpha/frontend/src/native.ts",
      rule: "module-renderer-import",
    }],
  );
});

test("allows Tauri only in the trusted platform tree", async (t) => {
  const root = await fixture({
    "core/frontend/platform/native.ts":
      "import { invoke } from '@tauri-apps/api/core'; export { invoke };",
    "core/frontend/host/native.ts":
      "import { invoke } from '@tauri-apps/api/core'; export { invoke };",
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(
    (await checkModuleBoundaries(root)).map(({ file, rule }) => ({ file, rule })),
    [{
      file: "core/frontend/host/native.ts",
      rule: "tauri-import-outside-platform",
    }],
  );
});

test("holds terminal scenarios to their port", async (t) => {
  const root = await fixture({
    // Sibling imports inside the harness are how a scenario is written.
    "core/frontend/terminal-host/scenarios/scenarioCatalog.ts":
      "import type { TerminalScenario } from './scenarioContract.ts'; export const all: TerminalScenario[] = [];",
    "core/frontend/terminal-host/scenarios/scenarioContract.ts": "export type TerminalScenario = { id: string };",
    // Reaching the renderer, a capability entrypoint, or xterm defeats the
    // claim the harness exists to make.
    "core/frontend/terminal-host/scenarios/leaky.ts":
      "import { terminalCache } from '../terminalCache.ts'; import { Terminal } from '@xterm/xterm'; export const x = [terminalCache, Terminal];",
    "core/frontend/terminal-host/terminalCache.ts": "export const terminalCache = new Map();",
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const diagnostics = await checkModuleBoundaries(root);
  assert.deepEqual(
    diagnostics.map(({ rule, specifier }) => ({ rule, specifier })),
    [
      { rule: "scenario-port-only", specifier: "../terminalCache.ts" },
      { rule: "scenario-port-only", specifier: "@xterm/xterm" },
    ],
    "the sibling imports pass and both reaches out of the harness are reported",
  );
});
