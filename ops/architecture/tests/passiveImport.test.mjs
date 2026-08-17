import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import fc from "fast-check";

import {
  moduleTopLevelEffects,
  parseTypeScriptSource,
} from "../../modularity/lib/module-boundaries.mjs";

const exec = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const probePath = path.join(repositoryRoot, "ops/architecture/bin/probe-import.mjs");

function pluginSource(classification, dependency) {
  const importedDependency = dependency ? `import ${JSON.stringify(dependency)};\n` : "";
  const effects = {
    passive: "",
    filesystem: "import { readFileSync } from 'node:fs';\nreadFileSync(new URL(import.meta.url));",
    network: "fetch('https://invalid.shipctl.test/');",
    timer: "setTimeout(() => undefined, 0);",
    registry: "globalThis.registry.register('fixture');",
    tauri: "globalThis.__TAURI_INTERNALS__.invoke('fixture');",
  };
  return `${importedDependency}${effects[classification]}\nexport const descriptor = { id: 'fixture' };\n`;
}

async function inspectImportPlan(plan) {
  const root = await mkdtemp(path.join(os.tmpdir(), "shipctl-passive-import-"));
  try {
    const urls = [];
    const staticChannels = [];
    for (const [index, item] of plan.entries()) {
      const name = `plugin-${index}.mjs`;
      const dependency = item.dependsOnPrevious && index > 0
        ? `./plugin-${index - 1}.mjs`
        : null;
      const source = pluginSource(item.classification, dependency);
      const file = path.join(root, name);
      await writeFile(file, source);
      urls.push(pathToFileURL(file).href);
      staticChannels.push(...moduleTopLevelEffects(
        parseTypeScriptSource(name, source),
      ).map(({ channel }) => channel));
    }
    const { stdout } = await exec(process.execPath, [probePath, JSON.stringify(urls)]);
    const runtimeChannels = JSON.parse(stdout).events.map(({ channel }) => channel);
    return { runtimeChannels, staticChannels };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("architecture.plugin.passive-import.property", async () => {
  const planArbitrary = fc.array(fc.record({
    classification: fc.constantFrom(
      "passive",
      "filesystem",
      "network",
      "timer",
      "registry",
      "tauri",
    ),
    dependsOnPrevious: fc.boolean(),
  }));

  const allClassifications = [
    "passive",
    "filesystem",
    "network",
    "timer",
    "registry",
    "tauri",
  ].map((classification, index) => ({
    classification,
    dependsOnPrevious: index > 0,
  }));

  await fc.assert(fc.asyncProperty(planArbitrary, async (plan) => {
    const expected = plan
      .map(({ classification }) => classification)
      .filter((classification) => classification !== "passive");
    const observed = await inspectImportPlan(plan);
    assert.deepEqual(observed.runtimeChannels, expected);
    assert.deepEqual(observed.staticChannels, expected);
  }), { examples: [[allClassifications]] });
});
